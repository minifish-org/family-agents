package store

import (
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
)

func ValidateReason(reason string) error {
	if len(strings.TrimSpace(reason)) < 10 || len(reason) > 500 {
		return errors.New("a recovery reason of 10 to 500 bytes is required; do not include secrets")
	}
	return nil
}

// ResetIdentity commits the one-shot reset intent before any network operation. Old stores remain archived.
func (s *Store) ResetIdentity(agent, device, reason string) error {
	if err := ValidateReason(reason); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	unsettled, err := s.Unsettled(agent)
	if err != nil {
		return err
	}
	if unsettled {
		return errors.New("resolve all pending runs and deliveries before resetting identity")
	}
	state, err := s.State(agent)
	if err != nil {
		return err
	}
	if state.ResetCount != 0 {
		return errors.New("identity reset loop guard is set; restore keys or provision a new agent")
	}
	secrets, err := s.Secrets(agent)
	if err != nil {
		return err
	}
	if secrets.Password == "" {
		return errors.New("a bot password is required to initialize a replacement device")
	}
	state.Generation++
	state.Device = device
	state.CryptoReady = false
	state.ResetCount++
	state.ResetReason = reason
	state.RecoveryImpossible = ""
	state.LastError = "Identity reset requested; original keys retained in the prior generation"
	secrets.AccessToken = ""
	secrets.PickleKey = nil
	stateJSON, err := json.Marshal(state)
	if err != nil {
		return err
	}
	secretJSON, err := json.Marshal(secrets)
	if err != nil {
		return err
	}
	return s.App.RunInTransaction(func(app core.App) error {
		_, err := app.DB().NewQuery(`INSERT INTO post_state(agent,value) VALUES({:a},{:v}) ON CONFLICT(agent) DO UPDATE SET value=excluded.value`).Bind(dbx.Params{"a": agent, "v": string(stateJSON)}).Execute()
		if err != nil {
			return err
		}
		_, err = app.DB().NewQuery(`INSERT INTO post_secrets(agent,value) VALUES({:a},{:v}) ON CONFLICT(agent) DO UPDATE SET value=excluded.value`).Bind(dbx.Params{"a": agent, "v": s.seal(agent, secretJSON)}).Execute()
		if err != nil {
			return err
		}
		_, err = app.DB().NewQuery(`INSERT INTO post_audit(agent,action,reason,created) VALUES({:a},'reset-identity',{:r},{:t})`).Bind(dbx.Params{"a": agent, "r": reason, "t": time.Now().UnixMilli()}).Execute()
		return err
	})
}

// DiscardDelivery is an explicit, audited escape hatch for an undeliverable outbox item.
// A lost acknowledgement means the event may already be visible in Matrix.
func (s *Store) DiscardDelivery(agent, id, reason string) error {
	if err := ValidateReason(reason); err != nil {
		return err
	}
	return s.App.RunInTransaction(func(app core.App) error {
		result, err := app.DB().NewQuery(`UPDATE post_outbox SET sent=1 WHERE agent={:a} AND id={:id} AND sent=0`).Bind(dbx.Params{"a": agent, "id": id}).Execute()
		if err != nil {
			return err
		}
		n, err := result.RowsAffected()
		if err != nil {
			return err
		}
		if n != 1 {
			return errors.New("pending delivery not found")
		}
		if _, err = app.DB().NewQuery(`INSERT INTO post_discarded(id,created) VALUES({:id},{:t})`).Bind(dbx.Params{"id": id, "t": time.Now().UnixMilli()}).Execute(); err != nil {
			return err
		}
		_, err = app.DB().NewQuery(`INSERT INTO post_audit(agent,action,reason,created) VALUES({:a},'discard-delivery',{:r},{:t})`).Bind(dbx.Params{"a": agent, "r": id + ": " + reason, "t": time.Now().UnixMilli()}).Execute()
		return err
	})
}
