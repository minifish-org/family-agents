package matrix

import (
	"context"
	"encoding/json"
	"errors"
	"sort"
	"time"

	"github.com/minifish-org/pith-post/internal/domain"
	"maunium.net/go/mautrix"
	"maunium.net/go/mautrix/event"
	"maunium.net/go/mautrix/id"
)

func ownerInvitations(c domain.Config, response *mautrix.RespSync) []id.RoomID {
	var rooms []id.RoomID
	for room, data := range response.Rooms.Invite {
		for _, e := range data.State.Events {
			_ = e.Content.ParseRaw(e.Type)
			if e.Type == event.StateMember && e.StateKey != nil && *e.StateKey == c.Bot && string(e.Sender) == c.Owner && e.Content.AsMember().Membership == event.MembershipInvite {
				rooms = append(rooms, room)
				break
			}
		}
	}
	sort.Slice(rooms, func(i, j int) bool { return rooms[i] < rooms[j] })
	return rooms
}

func (t *Transport) privatePair(ctx context.Context, room id.RoomID) error {
	response, err := t.client.Members(ctx, room)
	if err != nil {
		return err
	}
	s := domain.Snapshot{Room: string(room), Encrypted: true}
	for _, e := range response.Chunk {
		if e.Type != event.StateMember || e.StateKey == nil {
			return domain.ErrPaused
		}
		s.Members = append(s.Members, domain.Member{MXID: *e.StateKey, Membership: string(e.Content.AsMember().Membership)})
	}
	return domain.OwnerOnly(t.config, string(room), s)
}

// The worker is stopped while connecting. Pending work must keep its original destination.
func (t *Transport) connectRequestedChat(ctx context.Context, room id.RoomID) error {
	pending, err := t.store.Unsettled(t.config.ID)
	if err != nil {
		return err
	}
	if pending {
		return errors.New("resolve pending work before changing private chats")
	}
	if err = t.privatePair(ctx, room); err != nil {
		response, e := t.invitationSync(ctx, room)
		if e != nil {
			return errors.New("cannot verify private invitation")
		}
		invited := false
		for _, candidate := range ownerInvitations(t.config, response) {
			if candidate == room {
				invited = true
			}
		}
		if !invited {
			return errors.New("this chat needs an invitation from its configured person")
		}
		if _, err = t.client.JoinRoom(ctx, string(room), nil); err != nil {
			return errors.New("could not accept the private invitation")
		}
		if err = t.privatePair(ctx, room); err != nil {
			return errors.New("the new chat must contain only its person and assistant")
		}
	}
	var encryption event.EncryptionEventContent
	err = t.client.StateEvent(ctx, room, event.StateEncryption, "", &encryption)
	if err != nil {
		if !errors.Is(err, mautrix.MNotFound) {
			return errors.New("could not check chat encryption")
		}
		if _, err = t.client.SendStateEvent(ctx, room, event.StateEncryption, "", &event.EncryptionEventContent{Algorithm: id.AlgorithmMegolmV1}); err != nil {
			return errors.New("enable encryption in this private chat, then try again")
		}
	} else if encryption.Algorithm != id.AlgorithmMegolmV1 {
		return errors.New("unsupported chat encryption")
	}
	snap, err := snapshot(ctx, t.client, room)
	if err != nil {
		return err
	}
	if err = domain.OwnerOnly(t.config, string(room), snap); err != nil {
		return err
	}
	if err = t.store.UpdateState(t.config.ID, func(s *domain.State) error {
		s.ChatSyncPending = true
		s.ChatConnectedAt = time.Now().UnixMilli()
		s.Room = string(room)
		s.RequestedRoom = ""
		s.RoomCreating = false
		s.AwaitingOwner = false
		s.Paused = ""
		s.LastError = ""
		s.SecurityEpoch++
		return nil
	}); err != nil {
		return err
	}
	t.room = room
	return t.store.Audit(t.config.ID, "connect-chat", "Connected the person's private encrypted chat; original identity and history retained")
}

func (t *Transport) requestChat(ctx context.Context, response *mautrix.RespSync, since string) error {
	pending, err := t.store.Unsettled(t.config.ID)
	if err != nil || pending {
		return err
	}
	var candidate id.RoomID
	invitations := ownerInvitations(t.config, response)
	if len(invitations) == 1 {
		candidate = invitations[0]
	}
	// Only a fresh owner message can switch an already joined DM. Initial history is not a request.
	current, err := t.store.State(t.config.ID)
	if err != nil {
		return err
	}
	var newest int64 = current.ChatConnectedAt
	if candidate == "" && since != "" {
		for room, data := range response.Rooms.Join {
			if room == t.room {
				continue
			}
			for _, e := range data.Timeline.Events {
				if string(e.Sender) != t.config.Owner || (e.Type != event.EventMessage && e.Type != event.EventEncrypted) || e.Timestamp <= newest {
					continue
				}
				if t.privatePair(ctx, room) != nil {
					continue
				}
				candidate = room
				newest = e.Timestamp
			}
		}
	}
	if candidate == "" || candidate == t.room {
		return nil
	}
	if err = t.store.UpdateState(t.config.ID, func(s *domain.State) error { s.RequestedRoom = string(candidate); return nil }); err != nil {
		return err
	}
	// Save a first encrypted request before restarting the room-bound transport.
	if room, ok := response.Rooms.Join[candidate]; ok {
		for _, e := range room.Timeline.Events {
			if e.Type == event.EventEncrypted && string(e.Sender) == t.config.Owner && e.ID != "" {
				copy := *e
				copy.RoomID = candidate
				if err = t.holdEvent(&copy); err != nil {
					return err
				}
			}
		}
	}
	return domain.ErrChatRequested
}

func (t *Transport) invitationSync(ctx context.Context, room id.RoomID) (*mautrix.RespSync, error) {
	filter := &mautrix.Filter{Room: &mautrix.RoomFilter{Timeline: &mautrix.FilterPart{Limit: 0}}}
	if room != "" {
		filter.Room.Rooms = []id.RoomID{room}
	}
	raw, _ := json.Marshal(filter)
	return t.client.FullSyncRequest(ctx, mautrix.ReqSync{Timeout: 0, FilterID: string(raw)})
}
func (t *Transport) holdEvent(e *event.Event) error {
	raw, err := json.Marshal(e)
	if err != nil {
		return err
	}
	return t.store.HoldEncrypted(t.config.ID, string(e.ID), raw)
}
