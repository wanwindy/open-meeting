package noderegistry

import (
	"sort"
	"sync"
	"time"
)

type Node struct {
	ID            string    `json:"node_id"`
	Hostname      string    `json:"hostname"`
	GRPCAddress   string    `json:"grpc_address"`
	Status        string    `json:"status"`
	ActiveSession int       `json:"active_sessions"`
	LastHeartbeat time.Time `json:"last_heartbeat"`
}

type Registry struct {
	mu    sync.RWMutex
	nodes map[string]Node
}

func New() *Registry {
	return &Registry{
		nodes: map[string]Node{},
	}
}

func (r *Registry) Register(node Node) Node {
	r.mu.Lock()
	defer r.mu.Unlock()

	node.Status = "online"
	node.LastHeartbeat = time.Now().UTC()
	r.nodes[node.ID] = node

	return node
}

func (r *Registry) Heartbeat(nodeID string, activeSessions int, status string) (Node, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()

	node, ok := r.nodes[nodeID]
	if !ok {
		return Node{}, false
	}

	node.ActiveSession = activeSessions
	if status != "" {
		node.Status = status
	}
	node.LastHeartbeat = time.Now().UTC()
	r.nodes[nodeID] = node

	return node, true
}

func (r *Registry) List() []Node {
	r.mu.RLock()
	defer r.mu.RUnlock()

	nodes := make([]Node, 0, len(r.nodes))
	for _, node := range r.nodes {
		nodes = append(nodes, node)
	}

	sort.Slice(nodes, func(i int, j int) bool {
		return nodes[i].ID < nodes[j].ID
	})

	return nodes
}

func (r *Registry) Get(nodeID string) (Node, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()

	node, ok := r.nodes[nodeID]
	return node, ok
}

func (n Node) IsOnline(now time.Time, staleAfter time.Duration) bool {
	if n.Status != "" && n.Status != "online" {
		return false
	}

	if staleAfter <= 0 {
		return true
	}

	return now.Sub(n.LastHeartbeat) <= staleAfter
}
