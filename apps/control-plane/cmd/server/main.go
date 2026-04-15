package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	noderegistry "open-meeting/apps/control-plane/internal/node-registry"
	"open-meeting/apps/control-plane/internal/scheduler"
	"open-meeting/apps/control-plane/internal/sessionstore"
	"open-meeting/apps/control-plane/internal/workerclient"
	grpcCodes "google.golang.org/grpc/codes"
	grpcstatus "google.golang.org/grpc/status"
)

const defaultNodeStaleAfter = 2 * time.Minute

type registerRequest struct {
	NodeID      string `json:"node_id"`
	Hostname    string `json:"hostname"`
	GRPCAddress string `json:"grpc_address"`
}

type heartbeatRequest struct {
	NodeID         string `json:"node_id"`
	ActiveSessions int    `json:"active_sessions"`
	Status         string `json:"status"`
}

type createSessionRequest struct {
	Source  sessionstore.MeetingEndpoint `json:"source"`
	Target  sessionstore.MeetingEndpoint `json:"target"`
	Options createSessionOptions         `json:"options"`
}

type createSessionOptions struct {
	EnableAudio          *bool  `json:"enable_audio"`
	EnableVideo          *bool  `json:"enable_video"`
	EnableAec            *bool  `json:"enable_aec"`
	DryRun               *bool  `json:"dry_run"`
	TraceID              string `json:"trace_id"`
	WebhookURL           string `json:"webhook_url"`
	NotifyWebhook        string `json:"notify_webhook"`
	MaxReconnectAttempts *int32 `json:"max_reconnect_attempts"`
}

type errorResponse struct {
	Error     string `json:"error"`
	SessionID string `json:"session_id,omitempty"`
}

type apiServer struct {
	registry     *noderegistry.Registry
	scheduler    *scheduler.Scheduler
	sessions     *sessionstore.Store
	workerClient *workerclient.Client
}

func main() {
	registry := noderegistry.New()
	workerClient, err := workerclient.NewFromEnv()
	if err != nil {
		log.Fatalf("failed to initialize worker client: %v", err)
	}

	api := &apiServer{
		registry:     registry,
		scheduler:    scheduler.New(registry, parseDurationEnv("CONTROL_PLANE_NODE_STALE_AFTER", defaultNodeStaleAfter)),
		sessions:     sessionstore.New(),
		workerClient: workerClient,
	}

	mux := http.NewServeMux()

	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		respondJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})

	mux.HandleFunc("/v1/nodes/register", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}

		var req registerRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			respondError(w, http.StatusBadRequest, err.Error(), "")
			return
		}

		node := registry.Register(noderegistry.Node{
			ID:          req.NodeID,
			Hostname:    req.Hostname,
			GRPCAddress: req.GRPCAddress,
		})

		respondJSON(w, http.StatusCreated, node)
	})

	mux.HandleFunc("/v1/nodes/heartbeat", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}

		var req heartbeatRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			respondError(w, http.StatusBadRequest, err.Error(), "")
			return
		}

		node, ok := registry.Heartbeat(req.NodeID, req.ActiveSessions, req.Status)
		if !ok {
			respondError(w, http.StatusNotFound, "node not found", "")
			return
		}

		respondJSON(w, http.StatusOK, node)
	})

	mux.HandleFunc("/v1/nodes", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}

		respondJSON(w, http.StatusOK, registry.List())
	})

	mux.HandleFunc("/v1/sessions", api.handleSessions)
	mux.HandleFunc("/v1/sessions/", api.handleSessionByID)

	addr := envOrDefault("CONTROL_PLANE_ADDR", ":8080")
	log.Printf("control-plane MVP server listening on %s", addr)
	server := &http.Server{
		Addr:              addr,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      10 * time.Second,
		IdleTimeout:       30 * time.Second,
	}

	if err := server.ListenAndServe(); err != nil {
		log.Fatal(err)
	}
}

func (a *apiServer) handleSessions(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodPost:
		a.handleCreateSession(w, r)
	case http.MethodGet:
		a.handleListSessions(w, r)
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (a *apiServer) handleSessionByID(w http.ResponseWriter, r *http.Request) {
	sessionID := strings.TrimPrefix(r.URL.Path, "/v1/sessions/")
	if sessionID == "" || strings.Contains(sessionID, "/") {
		http.NotFound(w, r)
		return
	}

	switch r.Method {
	case http.MethodGet:
		a.handleGetSession(w, r, sessionID)
	case http.MethodDelete:
		a.handleStopSession(w, r, sessionID)
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (a *apiServer) handleCreateSession(w http.ResponseWriter, r *http.Request) {
	var req createSessionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, err.Error(), "")
		return
	}

	if err := validateCreateSessionRequest(req); err != nil {
		respondError(w, http.StatusBadRequest, err.Error(), "")
		return
	}

	node, err := a.scheduler.SelectNode(time.Now().UTC())
	if err != nil {
		statusCode := http.StatusServiceUnavailable
		if !errors.Is(err, scheduler.ErrNoAvailableNode) {
			statusCode = http.StatusInternalServerError
		}

		respondError(w, statusCode, err.Error(), "")
		return
	}

	options := req.Options.normalize()
	session := sessionstore.Session{
		ID:        randomID("sess"),
		NodeID:    node.ID,
		Status:    "CREATED",
		TraceID:   options.TraceID,
		Source:    normalizeEndpoint(req.Source),
		Target:    normalizeEndpoint(req.Target),
		Options:   options,
		CreatedAt: time.Now().UTC(),
	}
	a.sessions.Create(session)

	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()

	snapshot, err := a.workerClient.StartSession(ctx, node.GRPCAddress, workerclient.StartSessionInput{
		SessionID: session.ID,
		Source: workerclient.MeetingEndpoint{
			Platform:    session.Source.Platform,
			MeetingID:   session.Source.MeetingID,
			Password:    session.Source.Password,
			DisplayName: session.Source.DisplayName,
			MeetingURL:  session.Source.MeetingURL,
		},
		Target: workerclient.MeetingEndpoint{
			Platform:    session.Target.Platform,
			MeetingID:   session.Target.MeetingID,
			Password:    session.Target.Password,
			DisplayName: session.Target.DisplayName,
			MeetingURL:  session.Target.MeetingURL,
		},
		Options: workerclient.SessionOptions{
			EnableAudio:          session.Options.EnableAudio,
			EnableVideo:          session.Options.EnableVideo,
			EnableAec:            session.Options.EnableAec,
			DryRun:               session.Options.DryRun,
			TraceID:              session.Options.TraceID,
			WebhookURL:           session.Options.WebhookURL,
			MaxReconnectAttempts: session.Options.MaxReconnectAttempts,
		},
	})
	if err != nil {
		a.sessions.UpdateStatus(session.ID, "FAILED", session.TraceID, err.Error(), "start_failed")
		respondError(w, statusFromWorkerError(err), err.Error(), session.ID)
		return
	}

	updatedSession, _ := a.sessions.UpdateStatus(session.ID, snapshot.Status, snapshot.TraceID, snapshot.Message, "")
	respondJSON(w, http.StatusCreated, updatedSession)
}

func (a *apiServer) handleListSessions(w http.ResponseWriter, r *http.Request) {
	statusFilter := strings.TrimSpace(r.URL.Query().Get("status"))
	respondJSON(w, http.StatusOK, a.sessions.List(statusFilter))
}

func (a *apiServer) handleGetSession(w http.ResponseWriter, r *http.Request, sessionID string) {
	session, ok := a.sessions.Get(sessionID)
	if !ok {
		respondError(w, http.StatusNotFound, "session not found", sessionID)
		return
	}

	if refreshed, err := a.refreshSessionStatus(r.Context(), session); err == nil {
		session = refreshed
	} else {
		log.Printf("refresh session status failed for %s: %v", sessionID, err)
	}

	respondJSON(w, http.StatusOK, session)
}

func (a *apiServer) handleStopSession(w http.ResponseWriter, r *http.Request, sessionID string) {
	session, ok := a.sessions.Get(sessionID)
	if !ok {
		respondError(w, http.StatusNotFound, "session not found", sessionID)
		return
	}

	if sessionstore.IsTerminalStatus(session.Status) {
		respondJSON(w, http.StatusOK, session)
		return
	}

	node, ok := a.registry.Get(session.NodeID)
	if !ok {
		respondError(w, http.StatusBadGateway, "assigned worker node not found", sessionID)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()

	snapshot, err := a.workerClient.StopSession(ctx, node.GRPCAddress, sessionID, "manual")
	if err != nil {
		respondError(w, statusFromWorkerError(err), err.Error(), sessionID)
		return
	}

	updatedSession, _ := a.sessions.UpdateStatus(sessionID, snapshot.Status, session.TraceID, "manual", "manual")
	respondJSON(w, http.StatusOK, updatedSession)
}

func (a *apiServer) refreshSessionStatus(ctx context.Context, session sessionstore.Session) (sessionstore.Session, error) {
	if sessionstore.IsTerminalStatus(session.Status) {
		return session, nil
	}

	node, ok := a.registry.Get(session.NodeID)
	if !ok {
		return session, errors.New("assigned worker node not found")
	}

	statusContext, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	snapshot, err := a.workerClient.GetSessionStatus(statusContext, node.GRPCAddress, session.ID)
	if err != nil {
		return session, err
	}

	updatedSession, _ := a.sessions.UpdateStatus(session.ID, snapshot.Status, snapshot.TraceID, snapshot.Message, session.EndReason)
	return updatedSession, nil
}

func respondJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("content-type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func respondError(w http.ResponseWriter, status int, message string, sessionID string) {
	respondJSON(w, status, errorResponse{
		Error:     message,
		SessionID: sessionID,
	})
}

func envOrDefault(name string, fallback string) string {
	value := os.Getenv(name)
	if value == "" {
		return fallback
	}

	return value
}

func parseDurationEnv(name string, fallback time.Duration) time.Duration {
	value := os.Getenv(name)
	if value == "" {
		return fallback
	}

	parsed, err := time.ParseDuration(value)
	if err != nil {
		log.Printf("invalid duration for %s: %v; using %s", name, err, fallback)
		return fallback
	}

	return parsed
}

func validateCreateSessionRequest(req createSessionRequest) error {
	if strings.TrimSpace(req.Source.Platform) == "" {
		return errors.New("source.platform is required")
	}

	if strings.TrimSpace(req.Source.MeetingID) == "" {
		return errors.New("source.meeting_id is required")
	}

	if strings.TrimSpace(req.Target.Platform) == "" {
		return errors.New("target.platform is required")
	}

	if strings.TrimSpace(req.Target.MeetingID) == "" {
		return errors.New("target.meeting_id is required")
	}

	return nil
}

func normalizeEndpoint(endpoint sessionstore.MeetingEndpoint) sessionstore.MeetingEndpoint {
	normalized := endpoint
	normalized.Platform = strings.TrimSpace(normalized.Platform)
	normalized.MeetingID = strings.TrimSpace(normalized.MeetingID)
	normalized.Password = strings.TrimSpace(normalized.Password)
	normalized.DisplayName = strings.TrimSpace(normalized.DisplayName)
	normalized.MeetingURL = strings.TrimSpace(normalized.MeetingURL)

	if normalized.DisplayName == "" {
		normalized.DisplayName = "Open Meeting Bridge"
	}

	return normalized
}

func (o createSessionOptions) normalize() sessionstore.SessionOptions {
	webhookURL := strings.TrimSpace(o.WebhookURL)
	if webhookURL == "" {
		webhookURL = strings.TrimSpace(o.NotifyWebhook)
	}

	maxReconnectAttempts := int32(0)
	if o.MaxReconnectAttempts != nil {
		maxReconnectAttempts = *o.MaxReconnectAttempts
	}

	return sessionstore.SessionOptions{
		EnableAudio:          boolOrDefault(o.EnableAudio, true),
		EnableVideo:          boolOrDefault(o.EnableVideo, true),
		EnableAec:            boolOrDefault(o.EnableAec, false),
		DryRun:               boolOrDefault(o.DryRun, false),
		TraceID:              strings.TrimSpace(o.TraceID),
		WebhookURL:           webhookURL,
		MaxReconnectAttempts: maxReconnectAttempts,
	}
}

func boolOrDefault(value *bool, fallback bool) bool {
	if value == nil {
		return fallback
	}

	return *value
}

func randomID(prefix string) string {
	buffer := make([]byte, 8)
	if _, err := rand.Read(buffer); err != nil {
		return prefix + "_" + hex.EncodeToString([]byte(time.Now().UTC().Format("150405.000000000")))
	}

	return prefix + "_" + hex.EncodeToString(buffer)
}

func statusFromWorkerError(err error) int {
	grpcStatus, ok := grpcstatus.FromError(err)
	if !ok {
		return http.StatusBadGateway
	}

	switch grpcStatus.Code() {
	case grpcCodes.InvalidArgument:
		return http.StatusBadRequest
	case grpcCodes.NotFound:
		return http.StatusNotFound
	case grpcCodes.AlreadyExists:
		return http.StatusConflict
	case grpcCodes.DeadlineExceeded:
		return http.StatusGatewayTimeout
	case grpcCodes.Unavailable:
		return http.StatusServiceUnavailable
	default:
		return http.StatusBadGateway
	}
}
