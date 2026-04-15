package sessionstore

import (
	"sort"
	"sync"
	"time"
)

type MeetingEndpoint struct {
	Platform    string `json:"platform"`
	MeetingID   string `json:"meeting_id"`
	Password    string `json:"password,omitempty"`
	DisplayName string `json:"display_name"`
	MeetingURL  string `json:"meeting_url,omitempty"`
}

type SessionOptions struct {
	EnableAudio          bool   `json:"enable_audio"`
	EnableVideo          bool   `json:"enable_video"`
	EnableAec            bool   `json:"enable_aec"`
	DryRun               bool   `json:"dry_run"`
	TraceID              string `json:"trace_id,omitempty"`
	WebhookURL           string `json:"webhook_url,omitempty"`
	MaxReconnectAttempts int32  `json:"max_reconnect_attempts,omitempty"`
}

type Session struct {
	ID        string          `json:"id"`
	NodeID    string          `json:"node_id,omitempty"`
	Status    string          `json:"status"`
	TraceID   string          `json:"trace_id,omitempty"`
	Message   string          `json:"message,omitempty"`
	EndReason string          `json:"end_reason,omitempty"`
	Source    MeetingEndpoint `json:"source"`
	Target    MeetingEndpoint `json:"target"`
	Options   SessionOptions  `json:"options"`
	CreatedAt time.Time       `json:"created_at"`
	StartedAt *time.Time      `json:"started_at,omitempty"`
	EndedAt   *time.Time      `json:"ended_at,omitempty"`
}

type Store struct {
	mu       sync.RWMutex
	sessions map[string]Session
}

func New() *Store {
	return &Store{
		sessions: map[string]Session{},
	}
}

func (s *Store) Create(session Session) Session {
	return s.Put(session)
}

func (s *Store) Put(session Session) Session {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.sessions[session.ID] = session
	return session
}

func (s *Store) Get(id string) (Session, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	session, ok := s.sessions[id]
	return session, ok
}

func (s *Store) List(status string) []Session {
	s.mu.RLock()
	defer s.mu.RUnlock()

	sessions := make([]Session, 0, len(s.sessions))
	for _, session := range s.sessions {
		if status != "" && session.Status != status {
			continue
		}

		sessions = append(sessions, session)
	}

	sort.Slice(sessions, func(i int, j int) bool {
		if !sessions[i].CreatedAt.Equal(sessions[j].CreatedAt) {
			return sessions[i].CreatedAt.After(sessions[j].CreatedAt)
		}

		return sessions[i].ID > sessions[j].ID
	})

	return sessions
}

func (s *Store) UpdateStatus(id string, status string, traceID string, message string, endReason string) (Session, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()

	session, ok := s.sessions[id]
	if !ok {
		return Session{}, false
	}

	now := time.Now().UTC()
	session.Status = status

	if traceID != "" {
		session.TraceID = traceID
	}

	if message != "" {
		session.Message = message
	}

	if shouldSetStartedAt(status) && session.StartedAt == nil {
		startedAt := now
		session.StartedAt = &startedAt
	}

	if IsTerminalStatus(status) {
		if session.EndedAt == nil {
			endedAt := now
			session.EndedAt = &endedAt
		}

		if endReason != "" {
			session.EndReason = endReason
		}
	} else {
		session.EndedAt = nil
		if endReason != "" {
			session.EndReason = endReason
		}
	}

	s.sessions[id] = session
	return session, true
}

func IsTerminalStatus(status string) bool {
	return status == "FAILED" || status == "TERMINATED"
}

func shouldSetStartedAt(status string) bool {
	return status != "" && status != "CREATED"
}
