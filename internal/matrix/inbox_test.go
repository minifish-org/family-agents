package matrix

import (
	"context"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/minifish-org/pith-post/internal/domain"
	"github.com/minifish-org/pith-post/internal/testutil"
	"maunium.net/go/mautrix/crypto"
	"maunium.net/go/mautrix/event"
	"maunium.net/go/mautrix/id"
)

func TestRealMegolmOwnerEventStaysDurableUntilAdmissionSucceeds(t *testing.T) {
	s := testutil.Store(t)
	c := testutil.Agent(t, s, "inbox")
	state, _ := s.State(c.ID)
	if err := s.PutSecrets(c.ID, domain.Secrets{AccessToken: "offline-test-token"}); err != nil {
		t.Fatal(err)
	}
	server := &matrixServer{c: c, device: state.Device, events: map[string][]byte{}}
	httpServer := httptest.NewServer(server)
	defer httpServer.Close()
	c.Homeserver = httpServer.URL
	opened, err := (Factory{Store: s}).Open(context.Background(), c)
	if err != nil {
		t.Fatal(err)
	}
	defer opened.Close()
	transport := opened.(*Transport)
	owner := crypto.NewOlmAccount()
	signing, identity := owner.Keys()
	outbound, err := crypto.NewOutboundGroupSession(transport.room, &event.EncryptionEventContent{Algorithm: id.AlgorithmMegolmV1}, nil)
	if err != nil {
		t.Fatal(err)
	}
	inbound, err := crypto.NewInboundGroupSession(identity, signing, transport.room, outbound.Internal.Key(), time.Hour, 100, nil, false)
	if err != nil {
		t.Fatal(err)
	}
	inbound.KeySource = id.KeySourceDirect
	inbound.SourceUser = id.UserID(c.Owner)
	machine := transport.helper.Machine()
	machine.DisableDecryptKeyFetching = true
	if err = machine.CryptoStore.PutGroupSession(context.Background(), inbound); err != nil {
		t.Fatal(err)
	}
	if err = machine.CryptoStore.PutDevices(context.Background(), id.UserID(c.Owner), map[id.DeviceID]*id.Device{"OWNER_DEVICE": {UserID: id.UserID(c.Owner), DeviceID: "OWNER_DEVICE", SigningKey: signing, IdentityKey: identity}}); err != nil {
		t.Fatal(err)
	}
	plain, _ := json.Marshal(map[string]any{"room_id": transport.room, "type": "m.room.message", "content": map[string]string{"msgtype": "m.text", "body": "Encrypted owner request"}})
	ciphertext, err := outbound.Internal.Encrypt(plain)
	if err != nil {
		t.Fatal(err)
	}
	evt := event.Event{ID: "$encrypted-owner", Sender: id.UserID(c.Owner), RoomID: transport.room, Type: event.EventEncrypted, Timestamp: 1234, Content: event.Content{Parsed: &event.EncryptedEventContent{Algorithm: id.AlgorithmMegolmV1, SessionID: outbound.ID(), SenderKey: identity, MegolmCiphertext: ciphertext}}}
	raw, err := json.Marshal(&evt)
	if err != nil {
		t.Fatal(err)
	}
	if err = s.HoldEncrypted(c.ID, string(evt.ID), raw); err != nil {
		t.Fatal(err)
	}
	var probe event.Event
	if err = json.Unmarshal(raw, &probe); err != nil {
		t.Fatal(err)
	}
	if err = probe.Content.ParseRaw(probe.Type); err != nil {
		t.Fatal(err)
	}
	decoded, err := transport.helper.Decrypt(context.Background(), &probe)
	if err != nil {
		t.Fatalf("test event failed decryption: %v", err)
	}
	if _, ok := AcceptEvent(c, string(transport.room), decoded); !ok {
		t.Fatalf("test event failed admission: type=%v room=%v sender=%v crypto=%+v content=%+v", decoded.Type, decoded.RoomID, decoded.Sender, decoded.Mautrix, decoded.Content)
	}
	requested := map[string]bool{}
	err = transport.processInbox(context.Background(), func(in domain.Inbound) error {
		if !in.Decrypted || in.Sender != c.Owner || in.Text != "Encrypted owner request" {
			t.Error("owner event did not decrypt correctly")
		}
		return errors.New("simulated durable run commit failure")
	}, requested)
	if err == nil {
		t.Fatal("failed admission unexpectedly acknowledged the encrypted event")
	}
	waiting, err := s.WaitingKeys(c.ID)
	if err != nil || len(waiting) != 1 {
		t.Fatal("failed admission lost the durable encrypted event")
	}
	calls := 0
	if err = transport.processInbox(context.Background(), func(in domain.Inbound) error { calls++; _, e := s.Enqueue(c.ID, in.EventID, in.Text); return e }, requested); err != nil {
		t.Fatal(err)
	}
	if err = transport.processInbox(context.Background(), func(domain.Inbound) error { calls++; return nil }, requested); err != nil {
		t.Fatal(err)
	}
	if calls != 1 {
		t.Fatal("handled encrypted event was admitted more than once")
	}
	waiting, _ = s.WaitingKeys(c.ID)
	if len(waiting) != 0 {
		t.Fatal("successfully admitted event remains in the pending inbox")
	}

	// Exercise the actual HTTP sync loop, including its acknowledgement boundary.
	nextCipher, err := outbound.Internal.Encrypt(plain)
	if err != nil {
		t.Fatal(err)
	}
	next := evt
	next.ID = "$sync-owner"
	next.Timestamp++
	next.Content = event.Content{Parsed: &event.EncryptedEventContent{Algorithm: id.AlgorithmMegolmV1, SessionID: outbound.ID(), SenderKey: identity, MegolmCiphertext: nextCipher}}
	server.mu.Lock()
	server.syncEvent = &next
	server.syncCount = 0
	server.mu.Unlock()
	syncCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	err = transport.Run(syncCtx, func(domain.Inbound) error { return errors.New("simulated admission failure") }, func() error { return nil })
	if err == nil {
		t.Fatal("sync ignored admission failure")
	}
	cursor, err := transport.client.Store.LoadNextBatch(context.Background(), transport.client.UserID)
	if err != nil {
		t.Fatal(err)
	}
	if cursor != "" {
		t.Fatal("sync cursor advanced before durable admission")
	}
	server.mu.Lock()
	server.syncCount = 0
	server.mu.Unlock()
	admitted := 0
	_ = transport.Run(syncCtx, func(in domain.Inbound) error { admitted++; _, e := s.Enqueue(c.ID, in.EventID, in.Text); return e }, func() error { return nil })
	cursor, err = transport.client.Store.LoadNextBatch(context.Background(), transport.client.UserID)
	if err != nil {
		t.Fatal(err)
	}
	if cursor != "test-batch-1" || admitted != 1 {
		t.Fatal("successful sync did not commit exactly one admission before its cursor")
	}
}
