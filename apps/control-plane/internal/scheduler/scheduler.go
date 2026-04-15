package scheduler

import (
	"errors"
	"sort"
	"time"

	noderegistry "open-meeting/apps/control-plane/internal/node-registry"
)

var ErrNoAvailableNode = errors.New("no available worker node")

type Scheduler struct {
	registry   *noderegistry.Registry
	staleAfter time.Duration
}

func New(registry *noderegistry.Registry, staleAfter time.Duration) *Scheduler {
	return &Scheduler{
		registry:   registry,
		staleAfter: staleAfter,
	}
}

func (s *Scheduler) SelectNode(now time.Time) (noderegistry.Node, error) {
	nodes := s.registry.List()
	candidates := make([]noderegistry.Node, 0, len(nodes))

	for _, node := range nodes {
		if node.IsOnline(now, s.staleAfter) {
			candidates = append(candidates, node)
		}
	}

	if len(candidates) == 0 {
		return noderegistry.Node{}, ErrNoAvailableNode
	}

	sort.Slice(candidates, func(i int, j int) bool {
		if candidates[i].ActiveSession != candidates[j].ActiveSession {
			return candidates[i].ActiveSession < candidates[j].ActiveSession
		}

		if !candidates[i].LastHeartbeat.Equal(candidates[j].LastHeartbeat) {
			return candidates[i].LastHeartbeat.After(candidates[j].LastHeartbeat)
		}

		return candidates[i].ID < candidates[j].ID
	})

	return candidates[0], nil
}
