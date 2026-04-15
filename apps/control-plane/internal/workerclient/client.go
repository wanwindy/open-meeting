package workerclient

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/jhump/protoreflect/desc"
	"github.com/jhump/protoreflect/desc/protoparse"
	"github.com/jhump/protoreflect/dynamic"
	"github.com/jhump/protoreflect/dynamic/grpcdynamic"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
)

type MeetingEndpoint struct {
	Platform    string
	MeetingID   string
	Password    string
	DisplayName string
	MeetingURL  string
}

type SessionOptions struct {
	EnableAudio          bool
	EnableVideo          bool
	EnableAec            bool
	DryRun               bool
	TraceID              string
	WebhookURL           string
	MaxReconnectAttempts int32
}

type StartSessionInput struct {
	SessionID string
	Source    MeetingEndpoint
	Target    MeetingEndpoint
	Options   SessionOptions
}

type SessionSnapshot struct {
	SessionID string
	Status    string
	TraceID   string
	Message   string
}

type Client struct {
	token                  string
	serverName             string
	caPath                 string
	startSessionMethod     *desc.MethodDescriptor
	stopSessionMethod      *desc.MethodDescriptor
	getSessionStatusMethod *desc.MethodDescriptor
}

func NewFromEnv() (*Client, error) {
	service, err := loadWorkerService()
	if err != nil {
		return nil, err
	}

	startSessionMethod := service.FindMethodByName("StartSession")
	stopSessionMethod := service.FindMethodByName("StopSession")
	getSessionStatusMethod := service.FindMethodByName("GetSessionStatus")
	if startSessionMethod == nil || stopSessionMethod == nil || getSessionStatusMethod == nil {
		return nil, fmt.Errorf("worker service methods are incomplete in proto definition")
	}

	return &Client{
		token:                  firstNonEmpty(os.Getenv("CONTROL_PLANE_WORKER_TOKEN"), os.Getenv("WORKER_GRPC_TOKEN")),
		serverName:             os.Getenv("CONTROL_PLANE_WORKER_TLS_SERVER_NAME"),
		caPath:                 os.Getenv("CONTROL_PLANE_WORKER_TLS_CA_PATH"),
		startSessionMethod:     startSessionMethod,
		stopSessionMethod:      stopSessionMethod,
		getSessionStatusMethod: getSessionStatusMethod,
	}, nil
}

func (c *Client) StartSession(ctx context.Context, address string, input StartSessionInput) (SessionSnapshot, error) {
	conn, stub, err := c.connect(ctx, address)
	if err != nil {
		return SessionSnapshot{}, err
	}
	defer conn.Close()

	request, err := c.buildStartSessionRequest(input)
	if err != nil {
		return SessionSnapshot{}, err
	}

	responseMessage, err := stub.InvokeRpc(c.attachMetadata(ctx), c.startSessionMethod, request)
	if err != nil {
		return SessionSnapshot{}, err
	}
	response, err := asDynamicMessage(responseMessage)
	if err != nil {
		return SessionSnapshot{}, err
	}

	return SessionSnapshot{
		SessionID: stringValue(response.GetFieldByName("session_id")),
		Status:    stringValue(response.GetFieldByName("status")),
		TraceID:   stringValue(response.GetFieldByName("trace_id")),
	}, nil
}

func (c *Client) StopSession(ctx context.Context, address string, sessionID string, reason string) (SessionSnapshot, error) {
	conn, stub, err := c.connect(ctx, address)
	if err != nil {
		return SessionSnapshot{}, err
	}
	defer conn.Close()

	request := dynamic.NewMessage(c.stopSessionMethod.GetInputType())
	if err := request.TrySetFieldByName("session_id", sessionID); err != nil {
		return SessionSnapshot{}, err
	}
	if reason != "" {
		if err := request.TrySetFieldByName("reason", reason); err != nil {
			return SessionSnapshot{}, err
		}
	}

	responseMessage, err := stub.InvokeRpc(c.attachMetadata(ctx), c.stopSessionMethod, request)
	if err != nil {
		return SessionSnapshot{}, err
	}
	response, err := asDynamicMessage(responseMessage)
	if err != nil {
		return SessionSnapshot{}, err
	}

	return SessionSnapshot{
		SessionID: stringValue(response.GetFieldByName("session_id")),
		Status:    stringValue(response.GetFieldByName("status")),
	}, nil
}

func (c *Client) GetSessionStatus(ctx context.Context, address string, sessionID string) (SessionSnapshot, error) {
	conn, stub, err := c.connect(ctx, address)
	if err != nil {
		return SessionSnapshot{}, err
	}
	defer conn.Close()

	request := dynamic.NewMessage(c.getSessionStatusMethod.GetInputType())
	if err := request.TrySetFieldByName("session_id", sessionID); err != nil {
		return SessionSnapshot{}, err
	}

	responseMessage, err := stub.InvokeRpc(c.attachMetadata(ctx), c.getSessionStatusMethod, request)
	if err != nil {
		return SessionSnapshot{}, err
	}
	response, err := asDynamicMessage(responseMessage)
	if err != nil {
		return SessionSnapshot{}, err
	}

	return SessionSnapshot{
		SessionID: stringValue(response.GetFieldByName("session_id")),
		Status:    stringValue(response.GetFieldByName("status")),
		TraceID:   stringValue(response.GetFieldByName("trace_id")),
		Message:   stringValue(response.GetFieldByName("message")),
	}, nil
}

func (c *Client) buildStartSessionRequest(input StartSessionInput) (*dynamic.Message, error) {
	request := dynamic.NewMessage(c.startSessionMethod.GetInputType())
	if err := request.TrySetFieldByName("session_id", input.SessionID); err != nil {
		return nil, err
	}

	sourceField := c.startSessionMethod.GetInputType().FindFieldByName("source")
	targetField := c.startSessionMethod.GetInputType().FindFieldByName("target")
	optionsField := c.startSessionMethod.GetInputType().FindFieldByName("options")
	if sourceField == nil || targetField == nil || optionsField == nil {
		return nil, fmt.Errorf("worker proto is missing StartSession nested fields")
	}

	sourceMessage, err := buildEndpointMessage(sourceField.GetMessageType(), input.Source)
	if err != nil {
		return nil, err
	}
	if err := request.TrySetFieldByName("source", sourceMessage); err != nil {
		return nil, err
	}

	targetMessage, err := buildEndpointMessage(targetField.GetMessageType(), input.Target)
	if err != nil {
		return nil, err
	}
	if err := request.TrySetFieldByName("target", targetMessage); err != nil {
		return nil, err
	}

	optionsMessage, err := buildOptionsMessage(optionsField.GetMessageType(), input.Options)
	if err != nil {
		return nil, err
	}
	if err := request.TrySetFieldByName("options", optionsMessage); err != nil {
		return nil, err
	}

	return request, nil
}

func buildEndpointMessage(messageDescriptor *desc.MessageDescriptor, endpoint MeetingEndpoint) (*dynamic.Message, error) {
	message := dynamic.NewMessage(messageDescriptor)

	if err := message.TrySetFieldByName("platform", endpoint.Platform); err != nil {
		return nil, err
	}
	if err := message.TrySetFieldByName("meeting_id", endpoint.MeetingID); err != nil {
		return nil, err
	}
	if endpoint.Password != "" {
		if err := message.TrySetFieldByName("password", endpoint.Password); err != nil {
			return nil, err
		}
	}
	if endpoint.DisplayName != "" {
		if err := message.TrySetFieldByName("display_name", endpoint.DisplayName); err != nil {
			return nil, err
		}
	}
	if endpoint.MeetingURL != "" {
		if err := message.TrySetFieldByName("meeting_url", endpoint.MeetingURL); err != nil {
			return nil, err
		}
	}

	return message, nil
}

func buildOptionsMessage(messageDescriptor *desc.MessageDescriptor, options SessionOptions) (*dynamic.Message, error) {
	message := dynamic.NewMessage(messageDescriptor)

	if err := message.TrySetFieldByName("enable_audio", options.EnableAudio); err != nil {
		return nil, err
	}
	if err := message.TrySetFieldByName("enable_video", options.EnableVideo); err != nil {
		return nil, err
	}
	if err := message.TrySetFieldByName("enable_aec", options.EnableAec); err != nil {
		return nil, err
	}
	if err := message.TrySetFieldByName("dry_run", options.DryRun); err != nil {
		return nil, err
	}
	if options.TraceID != "" {
		if err := message.TrySetFieldByName("trace_id", options.TraceID); err != nil {
			return nil, err
		}
	}
	if options.WebhookURL != "" {
		if err := message.TrySetFieldByName("webhook_url", options.WebhookURL); err != nil {
			return nil, err
		}
	}
	if options.MaxReconnectAttempts > 0 {
		if err := message.TrySetFieldByName("max_reconnect_attempts", options.MaxReconnectAttempts); err != nil {
			return nil, err
		}
	}

	return message, nil
}

func (c *Client) connect(ctx context.Context, address string) (*grpc.ClientConn, grpcdynamic.Stub, error) {
	transportCredentials, err := c.transportCredentials()
	if err != nil {
		return nil, grpcdynamic.Stub{}, err
	}

	dialContext, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	conn, err := grpc.DialContext(
		dialContext,
		address,
		grpc.WithTransportCredentials(transportCredentials),
		grpc.WithBlock(),
	)
	if err != nil {
		return nil, grpcdynamic.Stub{}, err
	}

	return conn, grpcdynamic.NewStub(conn), nil
}

func (c *Client) transportCredentials() (credentials.TransportCredentials, error) {
	if c.caPath == "" && c.serverName == "" {
		return insecure.NewCredentials(), nil
	}

	tlsConfig := &tls.Config{
		MinVersion: tls.VersionTLS12,
	}

	if c.serverName != "" {
		tlsConfig.ServerName = c.serverName
	}

	if c.caPath != "" {
		certificateAuthority, err := os.ReadFile(c.caPath)
		if err != nil {
			return nil, err
		}

		rootCAs := x509.NewCertPool()
		if !rootCAs.AppendCertsFromPEM(certificateAuthority) {
			return nil, fmt.Errorf("failed to parse CONTROL_PLANE_WORKER_TLS_CA_PATH")
		}

		tlsConfig.RootCAs = rootCAs
	}

	return credentials.NewTLS(tlsConfig), nil
}

func (c *Client) attachMetadata(ctx context.Context) context.Context {
	if c.token == "" {
		return ctx
	}

	return metadata.AppendToOutgoingContext(ctx, "x-worker-token", c.token)
}

func loadWorkerService() (*desc.ServiceDescriptor, error) {
	protoPath, err := resolveProtoPath()
	if err != nil {
		return nil, err
	}

	parser := protoparse.Parser{
		ImportPaths: []string{filepath.Dir(protoPath)},
	}

	descriptors, err := parser.ParseFiles(filepath.Base(protoPath))
	if err != nil {
		return nil, err
	}

	if len(descriptors) == 0 {
		return nil, fmt.Errorf("worker proto descriptor list is empty")
	}

	service := descriptors[0].FindService("openmeeting.worker.v1.WorkerService")
	if service == nil {
		return nil, fmt.Errorf("worker service definition not found in proto")
	}

	return service, nil
}

func resolveProtoPath() (string, error) {
	candidates := make([]string, 0, 8)
	seen := map[string]struct{}{}

	appendCandidates := func(base string) {
		if base == "" {
			return
		}

		relativePaths := []string{
			filepath.Join("proto", "worker.proto"),
			filepath.Join("..", "proto", "worker.proto"),
			filepath.Join("..", "..", "proto", "worker.proto"),
			filepath.Join("..", "..", "..", "proto", "worker.proto"),
		}

		for _, relativePath := range relativePaths {
			candidate := filepath.Clean(filepath.Join(base, relativePath))
			if _, ok := seen[candidate]; ok {
				continue
			}

			seen[candidate] = struct{}{}
			candidates = append(candidates, candidate)
		}
	}

	currentWorkingDirectory, _ := os.Getwd()
	appendCandidates(currentWorkingDirectory)

	executablePath, _ := os.Executable()
	appendCandidates(filepath.Dir(executablePath))

	for _, candidate := range candidates {
		info, err := os.Stat(candidate)
		if err == nil && !info.IsDir() {
			return candidate, nil
		}
	}

	return "", fmt.Errorf("worker proto not found; checked %v", candidates)
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}

	return ""
}

func stringValue(value interface{}) string {
	if value == nil {
		return ""
	}

	return fmt.Sprint(value)
}

func asDynamicMessage(message interface{}) (*dynamic.Message, error) {
	response, ok := message.(*dynamic.Message)
	if !ok {
		return nil, fmt.Errorf("worker response has unexpected type %T", message)
	}

	return response, nil
}
