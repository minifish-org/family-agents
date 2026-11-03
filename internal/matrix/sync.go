package matrix

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/minifish-org/pith-post/internal/domain"
	"maunium.net/go/mautrix"
	"maunium.net/go/mautrix/crypto/cryptohelper"
	"maunium.net/go/mautrix/event"
	"maunium.net/go/mautrix/id"
)

// Deliberately not DispatchableSyncer: cryptohelper must not spawn asynchronous
// decryption handlers that could run after we acknowledge the sync batch.
type durableSyncer struct{ base *mautrix.DefaultSyncer }

func newDurableSyncer() *durableSyncer { return &durableSyncer{base: mautrix.NewDefaultSyncer()} }
func (s *durableSyncer) ProcessResponse(ctx context.Context, r *mautrix.RespSync, since string) error {
	return s.base.ProcessResponse(ctx, r, since)
}
func (s *durableSyncer) OnFailedSync(r *mautrix.RespSync, err error) (time.Duration, error) {
	return s.base.OnFailedSync(r, err)
}
func (s *durableSyncer) GetFilterJSON(user id.UserID) *mautrix.Filter {
	return s.base.GetFilterJSON(user)
}
func (s *durableSyncer) OnSync(fn mautrix.SyncHandler)   { s.base.OnSync(fn) }
func (s *durableSyncer) OnEvent(fn mautrix.EventHandler) { s.base.OnEvent(fn) }
func (s *durableSyncer) OnEventType(kind event.Type, fn mautrix.EventHandler) {
	s.base.OnEventType(kind, fn)
}

func (t *Transport) processInbox(ctx context.Context, onEvent func(domain.Inbound) error, requested map[string]bool) error {
	waiting, err := t.store.WaitingKeys(t.config.ID)
	if err != nil {
		return err
	}
	state, err := t.store.State(t.config.ID)
	if err != nil {
		return err
	}
	for _, row := range waiting {
		if row.Conversation != state.Conversation {
			if err = t.store.HandledEncrypted(t.config.ID, row.Event); err != nil {
				return err
			}
			continue
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		var encrypted event.Event
		if err = json.Unmarshal(row.Raw, &encrypted); err != nil {
			return errors.New("stored encrypted event cannot be decoded")
		}
		if err = encrypted.Content.ParseRaw(encrypted.Type); err != nil {
			return errors.New("stored encrypted event content is invalid")
		}
		decrypted, err := t.helper.Decrypt(ctx, &encrypted)
		if err != nil {
			// Keep ciphertext for future key arrival and service restarts. Never reset identity here.
			if !requested[row.Event] {
				requested[row.Event] = true
				if errors.Is(err, cryptohelper.NoSessionFound) {
					c := encrypted.Content.AsEncrypted()
					t.helper.RequestSession(ctx, t.room, c.SenderKey, c.SessionID, encrypted.Sender, "")
				}
				t.helper.DecryptErrorCallback(&encrypted, err)
			}
			continue
		}
		if in, ok := AcceptEvent(t.config, string(t.room), decrypted); ok {
			if err = onEvent(in); err != nil {
				return err
			}
		}
		if err = t.store.HandledEncrypted(t.config.ID, row.Event); err != nil {
			return err
		}
	}
	return nil
}

func (t *Transport) Run(ctx context.Context, onEvent func(domain.Inbound) error, onMembership func() error) error {
	syncer := t.client.Syncer.(*durableSyncer)
	var handlerErr error
	syncer.OnEventType(event.EventEncrypted, func(_ context.Context, e *event.Event) {
		if handlerErr != nil || e.RoomID != t.room || string(e.Sender) != t.config.Owner || e.ID == "" {
			return
		}
		state, stateErr := t.store.State(t.config.ID)
		if stateErr != nil {
			handlerErr = stateErr
			return
		}
		if state.ChatSyncPending && e.Timestamp < state.ChatConnectedAt {
			return
		}
		raw, err := json.Marshal(e)
		if err == nil {
			err = t.store.HoldEncrypted(t.config.ID, string(e.ID), raw)
		}
		handlerErr = err
	})
	syncer.OnEventType(event.StateMember, func(_ context.Context, e *event.Event) {
		if handlerErr != nil || e.RoomID != t.room {
			return
		}
		unsafe := e.StateKey == nil
		if !unsafe {
			member := *e.StateKey
			membership := e.Content.AsMember().Membership
			unsafe = ((member == t.config.Owner || member == t.config.Bot) && membership != event.MembershipJoin) || ((member != t.config.Owner && member != t.config.Bot) && (membership == event.MembershipJoin || membership == event.MembershipInvite || membership == event.MembershipKnock))
		}
		state, stateErr := t.store.State(t.config.ID)
		if stateErr != nil {
			handlerErr = stateErr
			return
		}
		if unsafe && (state.ChatConnectedAt == 0 || e.Timestamp >= state.ChatConnectedAt) {
			handlerErr = t.store.UpdateState(t.config.ID, func(s *domain.State) error {
				s.Paused = "Unsafe room membership observed; administrator resume required"
				s.SecurityEpoch++
				return nil
			})
			if handlerErr != nil {
				return
			}
		}
		handlerErr = onMembership()
	})
	// Retain the all-room filter across restarts so a new filter cannot reset timeline continuity.
	filterState, err := t.store.State(t.config.ID)
	if err != nil {
		return err
	}
	filter := filterState.SyncFilterID
	if filter == "" {
		responseFilter, err := t.client.CreateFilter(ctx, &mautrix.Filter{Room: &mautrix.RoomFilter{IncludeLeave: true, Timeline: &mautrix.FilterPart{Limit: 100}}})
		if err != nil {
			return errors.New("cannot create Matrix sync filter")
		}
		filter = responseFilter.FilterID
		// SQLCryptoStore intentionally does not retain filter IDs; keep it with application state.
		if err = t.store.UpdateState(t.config.ID, func(s *domain.State) error { s.SyncFilterAll = true; s.SyncFilterID = filter; return nil }); err != nil {
			return err
		}
	}
	since, err := t.client.Store.LoadNextBatch(ctx, t.client.UserID)
	if err != nil {
		return err
	}
	requested := map[string]bool{}
	for ctx.Err() == nil {
		timeout := 30000
		if since == "" {
			timeout = 0
		}
		response, err := t.client.FullSyncRequest(ctx, mautrix.ReqSync{Since: since, FilterID: filter, Timeout: timeout})
		if err != nil {
			delay, fatal := syncer.OnFailedSync(response, err)
			if fatal != nil {
				return errors.New("Matrix sync authorization failed")
			}
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(delay):
				continue
			}
		}
		if err = t.requestChat(ctx, response, since); err != nil {
			// Do not acknowledge to-device events here; replay the batch through the new crypto transport.
			return err
		}
		state, stateErr := t.store.State(t.config.ID)
		if stateErr != nil {
			return stateErr
		}
		if room, ok := response.Rooms.Join[t.room]; ok && room.Timeline.Limited && !state.ChatSyncPending {
			if err = t.store.UpdateState(t.config.ID, func(s *domain.State) error {
				s.SyncWarning = "Some earlier messages may be missing. Send your request again."
				return nil
			}); err != nil {
				return err
			}
		}
		handlerErr = nil
		if err = syncer.ProcessResponse(ctx, response, since); err != nil {
			return errors.New("Matrix sync processing failed")
		}
		if handlerErr != nil {
			return handlerErr
		}
		if err = t.processInbox(ctx, onEvent, requested); err != nil {
			return err
		}
		// mautrix.Client.SyncWithContext saves this cursor BEFORE callbacks. We must do the opposite.
		if err = t.client.Store.SaveNextBatch(ctx, t.client.UserID, response.NextBatch); err != nil {
			return err
		}
		if state.ChatSyncPending {
			if err = t.store.UpdateState(t.config.ID, func(s *domain.State) error { s.ChatSyncPending = false; return nil }); err != nil {
				return err
			}
		}
		since = response.NextBatch
	}
	return ctx.Err()
}
