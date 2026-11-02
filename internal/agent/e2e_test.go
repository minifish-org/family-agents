package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/minifish-org/pith-post/internal/domain"
	"github.com/minifish-org/pith-post/internal/pith"
	"github.com/minifish-org/pith-post/internal/testutil"
)

func TestServiceRestartWithRealPithSDKAndHTTPModelDouble(t *testing.T) {
	var mu sync.Mutex
	requests := []string{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" {
			t.Error("unexpected model endpoint")
			http.NotFound(w, r)
			return
		}
		if r.Header.Get("Authorization") != "Bearer local-no-key" {
			t.Error("model request used ambient or unexpected credentials")
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
			w.WriteHeader(400)
			return
		}
		if tools, ok := body["tools"].([]any); ok && len(tools) > 0 {
			t.Error("HTTP model request exposed tools")
		}
		raw, _ := json.Marshal(body)
		mu.Lock()
		requests = append(requests, string(raw))
		mu.Unlock()
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"id\":\"reply\",\"object\":\"chat.completion.chunk\",\"model\":\"test-model\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"I remember the blue bicycle.\"},\"finish_reason\":null}]}\n\ndata: {\"id\":\"reply\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
	}))
	defer server.Close()
	s := testutil.Store(t)
	c := testutil.Agent(t, s, "sdk-path")
	record, err := s.App.FindRecordById("agents", c.ID)
	if err != nil {
		t.Fatal(err)
	}
	record.Set("model_url", server.URL+"/v1")
	if err = s.App.Save(record); err != nil {
		t.Fatal(err)
	}
	transport := newTransport(c)
	factory := func(context.Context, domain.Config) (domain.Transport, error) { return transport, nil }
	m := New(s, pith.Model{}, factory)
	m.Interval = 5 * time.Millisecond
	if err = m.Start(c.ID); err != nil {
		t.Fatal(err)
	}
	transport.event(c, "$first", "Remember the blue bicycle")
	eventually(t, func() bool { return transport.count() == 1 })
	m.Close()
	// Recreate the service manager, recover durable jobs, and reopen the SDK's explicit session file.
	if err = s.Init(); err != nil {
		t.Fatal(err)
	}
	m = New(s, pith.Model{}, factory)
	m.Interval = 5 * time.Millisecond
	defer m.Close()
	if err = m.Start(c.ID); err != nil {
		t.Fatal(err)
	}
	transport.event(c, "$first", "Remember the blue bicycle")
	transport.event(c, "$second", "What do you remember?")
	eventually(t, func() bool { return transport.count() == 2 })
	mu.Lock()
	defer mu.Unlock()
	if len(requests) != 2 || !strings.Contains(requests[1], "Remember the blue bicycle") || !strings.Contains(requests[1], "I remember the blue bicycle.") {
		t.Fatal("service restart lost the SDK conversation or replayed an event")
	}
}
