package matrix

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/minifish-org/pith-post/internal/domain"
	"github.com/minifish-org/pith-post/internal/testutil"
	"maunium.net/go/mautrix"
	"maunium.net/go/mautrix/event"
	"maunium.net/go/mautrix/id"
)

type matrixServer struct {
	mu            sync.Mutex
	c             domain.Config
	device        string
	keys          json.RawMessage
	upload        []byte
	created       map[string]any
	events        map[string][]byte
	sendCalls     int
	logins        int
	unsafe        bool
	failAck       bool
	syncEvent     *event.Event
	syncCount     int
	syncLimited   bool
	filterCreates int
}

func (s *matrixServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	reply := func(v any) { _ = json.NewEncoder(w).Encode(v) }
	switch {
	case strings.HasSuffix(r.URL.Path, "/filter"):
		s.filterCreates++
		reply(map[string]any{"filter_id": "test-filter"})
	case strings.HasSuffix(r.URL.Path, "/sync"):
		s.syncCount++
		if s.syncCount > 1 || s.syncEvent == nil {
			w.WriteHeader(401)
			reply(map[string]any{"errcode": "M_UNKNOWN_TOKEN", "error": "End of test sync"})
			return
		}
		reply(map[string]any{"next_batch": "test-batch-1", "device_one_time_keys_count": map[string]int{"signed_curve25519": 50}, "rooms": map[string]any{"join": map[string]any{string(s.syncEvent.RoomID): map[string]any{"timeline": map[string]any{"events": []*event.Event{s.syncEvent}, "limited": s.syncLimited}}}}})
	case strings.HasSuffix(r.URL.Path, "/login"):
		var req mautrix.ReqLogin
		_ = json.NewDecoder(r.Body).Decode(&req)
		s.device = string(req.DeviceID)
		s.logins++
		reply(map[string]any{"user_id": s.c.Bot, "device_id": s.device, "access_token": "offline-test-token"})
	case strings.HasSuffix(r.URL.Path, "/account/whoami"):
		reply(map[string]any{"user_id": s.c.Bot, "device_id": s.device})
	case strings.HasSuffix(r.URL.Path, "/keys/query"):
		devices := map[string]json.RawMessage{}
		if len(s.keys) > 0 {
			devices[s.device] = s.keys
		}
		reply(map[string]any{"device_keys": map[string]any{s.c.Bot: devices, s.c.Owner: map[string]any{}}, "failures": map[string]any{}})
	case strings.HasSuffix(r.URL.Path, "/keys/claim"):
		reply(map[string]any{"one_time_keys": map[string]any{}, "failures": map[string]any{}})
	case strings.HasSuffix(r.URL.Path, "/keys/upload"):
		var body map[string]json.RawMessage
		_ = json.NewDecoder(r.Body).Decode(&body)
		if raw := body["device_keys"]; len(raw) > 0 {
			s.keys = raw
		}
		reply(map[string]any{"one_time_key_counts": map[string]int{"signed_curve25519": 50}})
	case strings.HasSuffix(r.URL.Path, "/createRoom"):
		_ = json.NewDecoder(r.Body).Decode(&s.created)
		reply(map[string]any{"room_id": "!matrix:example.test"})
	case strings.Contains(r.URL.Path, "/state/m.room.encryption/"):
		reply(map[string]any{"algorithm": "m.megolm.v1.aes-sha2"})
	case strings.Contains(r.URL.Path, "/state/m.room.history_visibility/"):
		reply(map[string]any{"history_visibility": "joined"})
	case strings.HasSuffix(r.URL.Path, "/members"):
		members := []any{}
		for _, mxid := range []string{s.c.Owner, s.c.Bot} {
			members = append(members, map[string]any{"type": "m.room.member", "state_key": mxid, "sender": mxid, "content": map[string]any{"membership": "join"}})
		}
		if s.unsafe {
			members = append(members, map[string]any{"type": "m.room.member", "state_key": "@third:example.test", "sender": s.c.Owner, "content": map[string]any{"membership": "invite"}})
		}
		reply(map[string]any{"chunk": members})
	case strings.Contains(r.URL.Path, "/send/m.room.encrypted/"):
		raw, _ := io.ReadAll(r.Body)
		txn := r.URL.Path[strings.LastIndex(r.URL.Path, "/")+1:]
		s.events[txn] = raw
		s.sendCalls++
		if s.failAck {
			s.failAck = false
			w.WriteHeader(503)
			reply(map[string]any{"errcode": "M_UNKNOWN", "error": "Acknowledgement lost"})
			return
		}
		reply(map[string]any{"event_id": "$reply"})
	case strings.Contains(r.URL.Path, "/sendToDevice/"):
		reply(map[string]any{})
	case strings.HasSuffix(r.URL.Path, "/upload"):
		s.upload, _ = io.ReadAll(r.Body)
		if r.Header.Get("Content-Type") != "application/octet-stream" {
			w.WriteHeader(400)
			return
		}
		reply(map[string]any{"content_uri": "mxc://example.test/encrypted-image"})
	default:
		w.WriteHeader(404)
		reply(map[string]any{"errcode": "M_NOT_FOUND", "error": "Unsupported test endpoint"})
	}
}

func TestMautrixEncryptedImageDeviceRestoreAndStableRetry(t *testing.T) {
	s := testutil.Store(t)
	c := testutil.Agent(t, s, "matrix")
	if err := s.UpdateState(c.ID, func(st *domain.State) error { st.Device = ""; st.Room = ""; return nil }); err != nil {
		t.Fatal(err)
	}
	if err := s.PutSecrets(c.ID, domain.Secrets{Password: "offline-test-password"}); err != nil {
		t.Fatal(err)
	}
	server := &matrixServer{c: c, events: map[string][]byte{}}
	httpServer := httptest.NewServer(server)
	defer httpServer.Close()
	c.Homeserver = httpServer.URL
	f := Factory{Store: s}
	opened, err := f.Open(context.Background(), c)
	if err != nil {
		t.Fatal(err)
	}
	transport := opened.(*Transport)
	before := transport.helper.Machine().OwnIdentity()
	state, _ := s.State(c.ID)
	if state.Room != "!matrix:example.test" || !state.CryptoReady {
		t.Fatal("initialization did not persist the encrypted room and device")
	}
	server.mu.Lock()
	invites := server.created["invite"].([]any)
	if len(invites) != 1 || invites[0] != c.Owner {
		t.Error("room invited someone other than its owner")
	}
	server.mu.Unlock()
	image, err := base64.StdEncoding.DecodeString("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN6sAAAAASUVORK5CYII=")
	if err != nil {
		t.Fatal(err)
	}
	wire, err := transport.Prepare(context.Background(), domain.Content{Kind: "image", Name: "pixel.png", MIME: "image/png", Data: image})
	if err != nil {
		t.Fatalf("prepare failed: %v; cause: %v", err, errors.Unwrap(err))
	}
	if bytes.Contains(wire, []byte("pixel.png")) || bytes.Contains(wire, []byte("m.image")) {
		t.Fatal("message metadata was sent without encryption")
	}
	var encrypted event.EncryptedEventContent
	if err = json.Unmarshal(wire, &encrypted); err != nil {
		t.Fatal(err)
	}
	decrypted, err := transport.helper.Decrypt(context.Background(), &event.Event{Type: event.EventEncrypted, ID: "$test", RoomID: id.RoomID(state.Room), Sender: id.UserID(c.Bot), Content: event.Content{Parsed: &encrypted}})
	if err != nil {
		t.Fatal(err)
	}
	content := decrypted.Content.AsMessage()
	if content.MsgType != event.MsgImage || content.File == nil || content.URL != "" {
		t.Fatal("encrypted message did not contain an encrypted attachment")
	}
	server.mu.Lock()
	uploaded := append([]byte(nil), server.upload...)
	server.failAck = true
	server.mu.Unlock()
	if bytes.Equal(uploaded, image) {
		t.Fatal("attachment upload contained plaintext bytes")
	}
	if err = content.File.DecryptInPlace(uploaded); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(uploaded, image) {
		t.Fatal("attachment could not be decrypted")
	}
	if err = transport.Send(context.Background(), wire, "stable-transaction"); err == nil {
		t.Fatal("test did not simulate a lost acknowledgement")
	}
	if err = transport.Send(context.Background(), wire, "stable-transaction"); err != nil {
		t.Fatal(err)
	}
	server.mu.Lock()
	if len(server.events) != 1 || server.sendCalls != 2 {
		t.Error("retry did not produce one visible encrypted event")
	}
	server.mu.Unlock()
	// A single undecryptable event cannot replace the device or account.
	transport.helper.HandleEncrypted(context.Background(), &event.Event{Type: event.EventEncrypted, ID: "$broken", RoomID: id.RoomID(state.Room), Sender: id.UserID(c.Owner), Content: event.Content{Parsed: &event.EncryptedEventContent{Algorithm: id.AlgorithmMegolmV1, SessionID: "missing-session", MegolmCiphertext: []byte("invalid")}}})
	after := transport.helper.Machine().OwnIdentity()
	if before.IdentityKey != after.IdentityKey {
		t.Fatal("decryption failure reset the Matrix identity")
	}
	if err = transport.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := f.Open(context.Background(), c)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	restored := reopened.(*Transport).helper.Machine().OwnIdentity()
	if restored.IdentityKey != before.IdentityKey || restored.SigningKey != before.SigningKey {
		t.Fatal("restart did not restore the original crypto account")
	}
	server.mu.Lock()
	if server.logins != 1 {
		t.Error("normal restart logged the bot in again")
	}
	server.unsafe = true
	server.mu.Unlock()
	if err = reopened.Send(context.Background(), wire, "must-not-send"); err == nil {
		t.Fatal("transport sent to a room containing a third-party invitation")
	}
	server.mu.Lock()
	defer server.mu.Unlock()
	if len(server.events) != 1 {
		t.Fatal("unsafe room received an event")
	}
}

func TestInboundAdapterRejectsPlaintextUnknownKeysEditsAndOtherRooms(t *testing.T) {
	c := domain.Config{Owner: "@owner:example.test", Bot: "@bot:example.test"}
	good := event.Event{ID: "$in", Type: event.EventMessage, RoomID: "!room:example.test", Sender: id.UserID(c.Owner), Content: event.Content{Parsed: &event.MessageEventContent{MsgType: event.MsgText, Body: "Hello"}}, Mautrix: event.MautrixInfo{WasEncrypted: true, EventSource: event.SourceDecrypted, TrustSource: &id.Device{UserID: id.UserID(c.Owner)}, TrustState: id.TrustStateUnset}}
	if _, ok := AcceptEvent(c, string(good.RoomID), &good); !ok {
		t.Fatal("valid owner event was rejected")
	}
	mention := good
	mention.Content = event.Content{Parsed: &event.MessageEventContent{MsgType: event.MsgText, Body: "Hi assistant", Mentions: &event.Mentions{UserIDs: []id.UserID{id.UserID(c.Bot)}}}}
	if _, ok := AcceptEvent(c, string(good.RoomID), &mention); !ok {
		t.Fatal("owner mention in a private message was rejected")
	}
	for _, test := range []struct {
		name   string
		change func(*event.Event)
	}{
		{"plaintext", func(e *event.Event) { e.Mautrix.WasEncrypted = false }},
		{"unknown-key", func(e *event.Event) { e.Mautrix.TrustSource = nil }},
		{"forwarded-key", func(e *event.Event) { e.Mautrix.ForwardedKeys = true }},
		{"other-room", func(e *event.Event) { e.RoomID = "!other:example.test" }},
		{"non-owner", func(e *event.Event) { e.Sender = "@other:example.test" }},
		{"bot-event", func(e *event.Event) { e.Sender = id.UserID(c.Bot) }},
		{"edit", func(e *event.Event) {
			e.Content = event.Content{Parsed: &event.MessageEventContent{MsgType: event.MsgText, Body: "Edit", NewContent: &event.MessageEventContent{Body: "replacement"}}}
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			e := good
			test.change(&e)
			if _, ok := AcceptEvent(c, string(good.RoomID), &e); ok {
				t.Fatal("unauthorized event was accepted")
			}
		})
	}
}
