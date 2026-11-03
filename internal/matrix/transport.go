// Package matrix implements an encrypted, owner-bound mautrix-go transport.
package matrix

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/minifish-org/pith-post/internal/domain"
	"github.com/minifish-org/pith-post/internal/store"
	"github.com/rs/zerolog"
	"go.mau.fi/util/dbutil"
	"maunium.net/go/mautrix"
	"maunium.net/go/mautrix/crypto"
	"maunium.net/go/mautrix/crypto/attachment"
	"maunium.net/go/mautrix/crypto/cryptohelper"
	"maunium.net/go/mautrix/event"
	"maunium.net/go/mautrix/id"
	_ "modernc.org/sqlite"
)

type Factory struct{ Store *store.Store }

type encryptionError struct{ cause error }

func (e encryptionError) Error() string { return "message encryption failed" }
func (e encryptionError) Unwrap() error { return e.cause }

type Transport struct {
	client *mautrix.Client
	helper *cryptohelper.CryptoHelper
	store  *store.Store
	config domain.Config
	room   id.RoomID
	sendMu sync.Mutex
}

// Use the pure-Go SQLite driver explicitly; cryptohelper's string shorthand requires CGO.
func openCryptoDB(path string) (*dbutil.Database, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	uri := (&url.URL{Scheme: "file", Path: absolute}).String() + "?_pragma=foreign_keys(1)&_pragma=journal_mode(WAL)&_pragma=synchronous(FULL)&_pragma=busy_timeout(5000)&_txlock=immediate"
	raw, err := sql.Open("sqlite", uri)
	if err != nil {
		return nil, err
	}
	raw.SetMaxOpenConns(1)
	db, err := dbutil.NewWithDB(raw, "sqlite3")
	if err != nil {
		_ = raw.Close()
		return nil, err
	}
	return db, nil
}

func newClient(c domain.Config, token string) (*mautrix.Client, error) {
	cli, err := mautrix.NewClient(c.Homeserver, id.UserID(c.Bot), token)
	if err != nil {
		return nil, errors.New("invalid homeserver URL")
	}
	// Request errors can include response bodies. Never route the library logger to application logs.
	cli.Log = zerolog.Nop()
	cli.Syncer = newDurableSyncer()
	cli.DefaultHTTPRetries = 0 // Every retry must pass our membership gate again.
	cli.Client = &http.Client{Timeout: 45 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("Matrix redirects are disabled") }}
	return cli, nil
}
func randomDevice() string {
	raw := make([]byte, 12)
	if _, err := rand.Read(raw); err != nil {
		panic("secure random source unavailable")
	}
	return "PITHPOST_" + hex.EncodeToString(raw)
}

func (f Factory) login(ctx context.Context, c domain.Config) (*mautrix.Client, domain.Secrets, domain.State, error) {
	state, err := f.Store.State(c.ID)
	if err != nil {
		return nil, domain.Secrets{}, state, err
	}
	secrets, err := f.Store.Secrets(c.ID)
	if err != nil {
		return nil, secrets, state, err
	}
	cli, err := newClient(c, secrets.AccessToken)
	if err != nil {
		return nil, secrets, state, err
	}
	if secrets.AccessToken == "" {
		if state.CryptoReady {
			return nil, secrets, state, errors.New("replace the token for the original device; automatic relogin is disabled")
		}
		if secrets.Password == "" {
			return nil, secrets, state, errors.New("Matrix credentials are required")
		}
		if state.Device == "" {
			state.Device = randomDevice()
			if err = f.Store.UpdateState(c.ID, func(s *domain.State) error { s.Device = state.Device; return nil }); err != nil {
				return nil, secrets, state, err
			}
		}
		resp, e := cli.Login(ctx, &mautrix.ReqLogin{Type: mautrix.AuthTypePassword, Identifier: mautrix.UserIdentifier{Type: mautrix.IdentifierTypeUser, User: c.Bot}, Password: secrets.Password, DeviceID: id.DeviceID(state.Device), InitialDeviceDisplayName: "Pith Post", StoreCredentials: true})
		if e != nil || string(resp.UserID) != c.Bot || string(resp.DeviceID) != state.Device {
			return nil, secrets, state, errors.New("Matrix login failed or returned an unexpected identity")
		}
		secrets.AccessToken = resp.AccessToken
		if err = f.Store.PutSecrets(c.ID, secrets); err != nil {
			return nil, secrets, state, err
		}
	}
	who, err := cli.Whoami(ctx)
	if err != nil || string(who.UserID) != c.Bot || who.DeviceID == "" {
		return nil, secrets, state, errors.New("Matrix token identity could not be verified")
	}
	if state.Device != "" && state.Device != string(who.DeviceID) {
		return nil, secrets, state, errors.New("token belongs to a different device; restore original credentials")
	}
	if state.Device == "" {
		state.Device = string(who.DeviceID)
		if err = f.Store.UpdateState(c.ID, func(s *domain.State) error { s.Device = state.Device; return nil }); err != nil {
			return nil, secrets, state, err
		}
	}
	cli.DeviceID = id.DeviceID(state.Device)
	return cli, secrets, state, nil
}
func (f Factory) Open(ctx context.Context, c domain.Config) (domain.Transport, error) {
	cli, secrets, state, err := f.login(ctx, c)
	if err != nil {
		return nil, err
	}
	_, _, path, err := f.Store.Paths(c.ID, state)
	if err != nil {
		return nil, err
	}
	if state.CryptoReady {
		if info, e := os.Stat(path); e != nil || info.Size() == 0 {
			return nil, domain.ErrCryptoRecovery
		}
	}
	if len(secrets.PickleKey) == 0 {
		if state.CryptoReady {
			return nil, domain.ErrCryptoRecovery
		}
		secrets.PickleKey = make([]byte, 32)
		if _, err = rand.Read(secrets.PickleKey); err != nil {
			return nil, err
		}
		if err = f.Store.PutSecrets(c.ID, secrets); err != nil {
			return nil, err
		}
	}
	db, err := openCryptoDB(path)
	if err != nil {
		return nil, errors.New("cannot open crypto store")
	}
	helper, err := cryptohelper.NewCryptoHelper(cli, secrets.PickleKey, db)
	if err != nil {
		_ = db.Close()
		return nil, errors.New("cannot open crypto store")
	}
	if err = helper.Init(ctx); err != nil {
		_ = helper.Close()
		// Only identity/key failures qualify for the administrator-confirmed automatic reset path.
		for _, marker := range []string{"failed to load olm account", "mismatching identity key", "account is not marked as shared", "keys seem to have disappeared"} {
			if strings.Contains(err.Error(), marker) {
				return nil, domain.ErrCryptoRecovery
			}
		}
		return nil, errors.New("crypto initialization failed; restore original keys before considering a reset")
	}
	cli.Crypto = helper
	t := &Transport{client: cli, helper: helper, store: f.Store, config: c, room: id.RoomID(state.Room)}
	// Key requests must not bypass the bound-room gate or recipient tracking.
	defaultKeyShare := helper.Machine().AllowKeyShare
	helper.Machine().AllowKeyShare = func(ctx context.Context, device *id.Device, request event.RequestedKeyInfo) *crypto.KeyShareRejection {
		if request.RoomID != t.room || (string(device.UserID) != c.Owner && string(device.UserID) != c.Bot) || t.guard(ctx) != nil {
			return &crypto.KeyShareRejectNoResponse
		}
		return defaultKeyShare(ctx, device, request)
	}
	helper.DecryptErrorCallback = func(_ *event.Event, _ error) {
		_ = f.Store.UpdateState(c.ID, func(s *domain.State) error {
			s.LastError = "An event could not be decrypted; identity preserved"
			return nil
		})
	}
	if err = f.Store.UpdateState(c.ID, func(s *domain.State) error { s.CryptoReady = true; s.LastError = ""; return nil }); err != nil {
		t.Close()
		return nil, err
	}
	if state.RequestedRoom == "" && state.Paused != "" {
		if response, e := t.invitationSync(ctx, ""); e == nil {
			rooms := ownerInvitations(c, response)
			if len(rooms) == 1 {
				state.RequestedRoom = string(rooms[0])
				if err = f.Store.UpdateState(c.ID, func(s *domain.State) error { s.RequestedRoom = state.RequestedRoom; return nil }); err != nil {
					t.Close()
					return nil, err
				}
			}
		}
	}
	if state.RequestedRoom != "" {
		if err = t.connectRequestedChat(ctx, id.RoomID(state.RequestedRoom)); err != nil {
			t.Close()
			return nil, err
		}
	}
	if t.room == "" {
		if state.RoomCreating {
			t.Close()
			return nil, errors.New("room creation outcome is uncertain; bind the existing room as administrator")
		}
		if err = f.Store.UpdateState(c.ID, func(s *domain.State) error { s.RoomCreating = true; return nil }); err != nil {
			t.Close()
			return nil, err
		}
		high := 100
		empty := ""
		created, e := cli.CreateRoom(ctx, &mautrix.ReqCreateRoom{
			Visibility: "private", Preset: "private_chat", Name: c.Name, IsDirect: true, Invite: []id.UserID{id.UserID(c.Owner)},
			PowerLevelOverride: &event.PowerLevelsEventContent{Users: map[id.UserID]int{id.UserID(c.Bot): 100, id.UserID(c.Owner): 0}, InvitePtr: &high, StateDefaultPtr: &high, KickPtr: &high, BanPtr: &high},
			InitialState: []*event.Event{
				{Type: event.StateEncryption, StateKey: &empty, Content: event.Content{Parsed: &event.EncryptionEventContent{Algorithm: id.AlgorithmMegolmV1}}},
				{Type: event.StateHistoryVisibility, StateKey: &empty, Content: event.Content{Raw: map[string]any{"history_visibility": "joined"}}},
				{Type: event.StateGuestAccess, StateKey: &empty, Content: event.Content{Raw: map[string]any{"guest_access": "forbidden"}}},
			},
		})
		if e != nil {
			t.Close()
			return nil, errors.New("room creation outcome is uncertain; do not create another room automatically")
		}
		t.room = created.RoomID
		if err = f.Store.UpdateState(c.ID, func(s *domain.State) error {
			s.Room = string(t.room)
			s.RoomCreating = false
			s.AwaitingOwner = true
			return nil
		}); err != nil {
			t.Close()
			return nil, err
		}
	}
	if state.Paused == domain.TimelineGapHold {
		snap, e := t.Snapshot(ctx)
		if e == nil && domain.OwnerOnly(c, string(t.room), snap) == nil {
			if err = f.Store.UpdateState(c.ID, func(s *domain.State) error {
				if s.Paused == domain.TimelineGapHold {
					s.Paused = ""
					s.SyncWarning = "Some earlier messages may be missing. Send your request again."
				}
				return nil
			}); err != nil {
				t.Close()
				return nil, err
			}
		}
	}
	if actual, e := f.Store.Config(c.ID); e == nil && actual.Homeserver == c.Homeserver {
		verificationCtx, verificationCancel := context.WithTimeout(ctx, 15*time.Second)
		_ = t.verifyOwnDevice(verificationCtx)
		verificationCancel()
		profileCtx, profileCancel := context.WithTimeout(ctx, 10*time.Second)
		_ = f.SyncProfile(profileCtx, c.ID)
		profileCancel()
	}
	return t, nil
}

func snapshot(ctx context.Context, cli *mautrix.Client, room id.RoomID) (domain.Snapshot, error) {
	result := domain.Snapshot{Room: string(room)}
	if room == "" {
		return result, domain.ErrPaused
	}
	var encryption event.EncryptionEventContent
	if err := cli.StateEvent(ctx, room, event.StateEncryption, "", &encryption); err != nil {
		return result, domain.ErrPaused
	}
	result.Encrypted = encryption.Algorithm == id.AlgorithmMegolmV1
	members, err := cli.Members(ctx, room) // No membership filter: invites and knocks are security relevant.
	if err != nil {
		return result, domain.ErrPaused
	}
	for _, ev := range members.Chunk {
		if ev.Type != event.StateMember || ev.StateKey == nil {
			return result, domain.ErrPaused
		}
		result.Members = append(result.Members, domain.Member{MXID: *ev.StateKey, Membership: string(ev.Content.AsMember().Membership)})
	}
	return result, nil
}
func (t *Transport) Snapshot(ctx context.Context) (domain.Snapshot, error) {
	return snapshot(ctx, t.client, t.room)
}
func (t *Transport) guard(ctx context.Context) error {
	state, err := t.store.State(t.config.ID)
	if err != nil {
		return err
	}
	if state.Paused != "" {
		return domain.ErrPaused
	}
	s, err := t.Snapshot(ctx)
	if err == nil {
		if state.AwaitingOwner && domain.InitialInvitation(t.config, state.Room, s) {
			return domain.ErrAwaitingOwner
		}
		err = domain.OwnerOnly(t.config, state.Room, s)
	}
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if e := t.store.UpdateState(t.config.ID, func(s *domain.State) error {
			s.Paused = "Owner-only encrypted membership could not be verified"
			s.SecurityEpoch++
			return nil
		}); e != nil {
			return e
		}
		return domain.ErrPaused
	}
	return nil
}

// EncryptAttachment exposes the format used for uploads for deterministic round-trip tests.
func EncryptAttachment(c domain.Content) ([]byte, *event.EncryptedFileInfo, error) {
	if err := c.Validate(); err != nil {
		return nil, nil, err
	}
	encrypted := attachment.NewEncryptedFile()
	data := append([]byte(nil), c.Data...)
	encrypted.EncryptInPlace(data)
	return data, &event.EncryptedFileInfo{EncryptedFile: *encrypted}, nil
}
func (t *Transport) Prepare(ctx context.Context, c domain.Content) ([]byte, error) {
	t.sendMu.Lock()
	defer t.sendMu.Unlock()
	if err := c.Validate(); err != nil {
		return nil, err
	}
	if err := t.guard(ctx); err != nil {
		return nil, err
	}
	message := event.MessageEventContent{MsgType: event.MsgText, Body: c.Text}
	if c.Kind != "text" {
		encrypted, file, err := EncryptAttachment(c)
		if err != nil {
			return nil, err
		}
		upload, err := t.client.UploadBytes(ctx, encrypted, "application/octet-stream")
		if err != nil {
			return nil, errors.New("encrypted attachment upload failed")
		}
		file.URL = id.ContentURIString(upload.ContentURI.String())
		message = event.MessageEventContent{MsgType: event.MsgFile, Body: c.Name, FileName: c.Name, Info: &event.FileInfo{MimeType: c.MIME, Size: len(c.Data)}, File: file}
		if c.Kind == "image" {
			message.MsgType = event.MsgImage
		}
	}
	if err := t.guard(ctx); err != nil {
		return nil, err
	}
	encrypted, err := t.helper.Machine().EncryptMegolmEvent(ctx, t.room, event.EventMessage, &message)
	if crypto.IsShareError(err) {
		if err = t.guard(ctx); err != nil {
			return nil, err
		}
		// Never derive key recipients from a cache that can change after the membership check.
		err = t.helper.Machine().ShareGroupSession(ctx, t.room, []id.UserID{id.UserID(t.config.Owner), id.UserID(t.config.Bot)})
		if err != nil {
			_ = t.helper.Machine().CryptoStore.RemoveOutboundGroupSession(ctx, t.room)
		}
		if err == nil {
			encrypted, err = t.helper.Machine().EncryptMegolmEvent(ctx, t.room, event.EventMessage, &message)
		}
	}
	if err != nil {
		return nil, encryptionError{cause: err}
	}
	return json.Marshal(encrypted)
}
func (t *Transport) Send(ctx context.Context, wire []byte, txn string) error {
	t.sendMu.Lock()
	defer t.sendMu.Unlock()
	if err := t.guard(ctx); err != nil {
		return err
	}
	var encrypted event.EncryptedEventContent
	if json.Unmarshal(wire, &encrypted) != nil || encrypted.Algorithm != id.AlgorithmMegolmV1 {
		return errors.New("refusing non-encrypted outbox payload")
	}
	_, err := t.client.SendMessageEvent(ctx, t.room, event.EventEncrypted, &encrypted, mautrix.ReqSendEvent{TransactionID: txn, DontEncrypt: true})
	if err != nil {
		return errors.New("encrypted delivery failed; stable transaction retained")
	}
	return nil
}

func AcceptEvent(c domain.Config, room string, e *event.Event) (domain.Inbound, bool) {
	if e.Type != event.EventMessage || e.StateKey != nil || string(e.RoomID) != room || string(e.Sender) != c.Owner || string(e.Sender) == c.Bot || !e.Mautrix.WasEncrypted || e.Mautrix.EventSource&event.SourceDecrypted == 0 {
		return domain.Inbound{}, false
	}
	// Successful decryption alone does not authenticate an unknown or forwarded key's claimed sender.
	if e.Mautrix.TrustSource == nil || string(e.Mautrix.TrustSource.UserID) != c.Owner || e.Mautrix.ForwardedKeys || e.Mautrix.TrustState < id.TrustStateUnset || e.Mautrix.TrustState == id.TrustStateUnknownDevice || e.Mautrix.TrustState == id.TrustStateBackup {
		return domain.Inbound{}, false
	}
	content := e.Content.AsMessage()
	if content.MsgType != event.MsgText || content.NewContent != nil || (content.RelatesTo != nil && content.RelatesTo.Type == event.RelReplace) {
		return domain.Inbound{}, false
	}
	return domain.Inbound{EventID: string(e.ID), Room: room, Sender: string(e.Sender), Text: content.Body, Decrypted: true}, true
}
func (t *Transport) Close() error {
	t.client.StopSync()
	t.helper.Machine().Destroy()
	return t.helper.Close()
}

// Bind is only for recovering an uncertain initial room creation, never for switching an existing DM.
func (f Factory) Bind(ctx context.Context, c domain.Config, room string) error {
	if !strings.HasPrefix(room, "!") {
		return errors.New("a Matrix room ID is required")
	}
	cli, _, state, err := f.login(ctx, c)
	if err != nil {
		return err
	}
	if state.Room != "" {
		return errors.New("the bound room is immutable")
	}
	snap, err := snapshot(ctx, cli, id.RoomID(room))
	if err != nil {
		return err
	}
	if err = domain.OwnerOnly(c, room, snap); err != nil {
		return err
	}
	return f.Store.UpdateState(c.ID, func(s *domain.State) error { s.Room = room; s.RoomCreating = false; return nil })
}
