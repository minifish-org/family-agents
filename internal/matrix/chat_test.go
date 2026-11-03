package matrix

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/minifish-org/pith-post/internal/domain"
	"github.com/minifish-org/pith-post/internal/testutil"
	"maunium.net/go/mautrix"
	"maunium.net/go/mautrix/event"
	"maunium.net/go/mautrix/id"
)

func TestOwnerDMConnectionEnablesEncryptionAndPreservesIdentity(t *testing.T) {
	for _, kind := range []string{"owner", "stranger", "group", "pending"} {
		t.Run(kind, func(t *testing.T) {
			s := testutil.Store(t)
			c := testutil.Agent(t, s, "chat")
			before, _ := s.State(c.ID)
			_ = s.UpdateState(c.ID, func(st *domain.State) error { st.Paused = "Old room was left"; return nil })
			joined, encrypted := false, false
			joins := 0
			room := id.RoomID("!new:example.test")
			inviter := c.Owner
			if kind == "stranger" {
				inviter = "@stranger:example.test"
			}
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				reply := func(v any) { _ = json.NewEncoder(w).Encode(v) }
				switch {
				case strings.HasSuffix(r.URL.Path, "/members"):
					if !joined {
						w.WriteHeader(403)
						reply(map[string]string{"errcode": "M_FORBIDDEN"})
						return
					}
					members := []any{}
					users := []string{c.Owner, c.Bot}
					if kind == "group" {
						users = append(users, "@third:example.test")
					}
					for _, user := range users {
						members = append(members, map[string]any{"type": "m.room.member", "state_key": user, "content": map[string]string{"membership": "join"}})
					}
					reply(map[string]any{"chunk": members})
				case strings.HasSuffix(r.URL.Path, "/sync"):
					reply(map[string]any{"rooms": map[string]any{"invite": map[string]any{string(room): map[string]any{"invite_state": map[string]any{"events": []any{map[string]any{"type": "m.room.member", "sender": inviter, "state_key": c.Bot, "content": map[string]string{"membership": "invite"}}}}}}}})
				case strings.Contains(r.URL.Path, "/join/"):
					joined = true
					joins++
					reply(map[string]string{"room_id": string(room)})
				case strings.Contains(r.URL.Path, "/state/m.room.encryption/"):
					if r.Method == "PUT" {
						encrypted = true
						reply(map[string]string{"event_id": "$encryption"})
						return
					}
					if !encrypted {
						w.WriteHeader(404)
						reply(map[string]string{"errcode": "M_NOT_FOUND"})
						return
					}
					reply(map[string]string{"algorithm": "m.megolm.v1.aes-sha2"})
				default:
					w.WriteHeader(404)
				}
			}))
			defer server.Close()
			c.Homeserver = server.URL
			client, _ := newClient(c, "synthetic-test-token")
			transport := &Transport{client: client, store: s, config: c, room: id.RoomID(before.Room)}
			if kind == "pending" {
				_, _ = s.Enqueue(c.ID, "queued", "Keep original destination")
			}
			err := transport.connectRequestedChat(context.Background(), room)
			after, _ := s.State(c.ID)
			if kind == "owner" {
				if err != nil || after.Room != string(room) || after.Paused != "" || !encrypted || joins != 1 {
					t.Fatalf("owner DM failed: %v", err)
				}
				if after.Device != before.Device || after.Generation != before.Generation || after.Conversation != before.Conversation {
					t.Fatal("private chat replacement altered identity/history")
				}
			} else {
				if err == nil || after.Room != before.Room || encrypted {
					t.Fatal("unsafe room was adopted")
				}
				if (kind == "stranger" || kind == "pending") && joins != 0 {
					t.Fatal("unauthorized join")
				}
			}
		})
	}
}

func TestNewOwnerDMDoesNotReplayOldChatsOrMovePendingWork(t *testing.T) {
	s := testutil.Store(t)
	c := testutil.Agent(t, s, "requests")
	client, _ := newClient(c, "synthetic")
	tr := &Transport{client: client, store: s, config: c, room: "!original:example.test"}
	response := &mautrix.RespSync{}
	// Use real JSON parsing so stripped invitation content is parsed exactly as in a sync response.
	raw := `{"rooms":{"invite":{"!next:example.test":{"invite_state":{"events":[{"type":"m.room.member","sender":"` + c.Owner + `","state_key":"` + c.Bot + `","content":{"membership":"invite"}}]}}}}}`
	if err := json.Unmarshal([]byte(raw), response); err != nil {
		t.Fatal(err)
	}
	for _, e := range response.Rooms.Invite["!next:example.test"].State.Events {
		_ = e.Content.ParseRaw(event.StateMember)
	}
	_, _ = s.Enqueue(c.ID, "pending", "Do not redirect this task")
	if err := tr.requestChat(context.Background(), response, "cursor"); err != nil {
		t.Fatal(err)
	}
	state, _ := s.State(c.ID)
	if state.RequestedRoom != "" {
		t.Fatal("pending work was redirected")
	}
	runs, _, _ := s.History(c.ID)
	if err := s.CancelRun(c.ID, runs[0].ID); err != nil {
		t.Fatal(err)
	}
	if err := tr.requestChat(context.Background(), response, "cursor"); !errors.Is(err, domain.ErrChatRequested) {
		t.Fatal("owner invite did not request reconnect", err)
	}
	state, _ = s.State(c.ID)
	if state.Room != "!requests:example.test" || state.RequestedRoom != "!next:example.test" {
		t.Fatal("running transport changed destination before restart")
	}
}
