package matrix

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/minifish-org/pith-post/internal/domain"
	"maunium.net/go/mautrix"
	"maunium.net/go/mautrix/crypto"
	"maunium.net/go/mautrix/crypto/signatures"
	"maunium.net/go/mautrix/id"
)

func (t *Transport) ownKeys(ctx context.Context) (*mautrix.RespQueryKeys, error) {
	return t.client.QueryKeys(ctx, &mautrix.ReqQueryKeys{DeviceKeys: mautrix.DeviceKeysRequest{t.client.UserID: mautrix.DeviceIDList{}}})
}
func (t *Transport) selfSigned(keys *mautrix.RespQueryKeys) bool {
	user := t.client.UserID
	master, self := keys.MasterKeys[user], keys.SelfSigningKeys[user]
	if master.UserID != user || self.UserID != user || len(master.Keys) != 1 || len(self.Keys) != 1 {
		return false
	}
	var masterKey, selfKey id.Ed25519
	for _, value := range master.Keys {
		masterKey = value
	}
	for _, value := range self.Keys {
		selfKey = value
	}
	valid, err := signatures.VerifySignatureJSON(master, user, t.client.DeviceID.String(), id.Ed25519(t.helper.Machine().OwnIdentity().SigningKey))
	if err != nil || !valid {
		return false
	}
	valid, err = signatures.VerifySignatureJSON(self, user, masterKey.String(), masterKey)
	if err != nil || !valid {
		return false
	}
	device, ok := keys.DeviceKeys[user][t.client.DeviceID]
	if !ok {
		return false
	}
	if device.Keys[id.NewDeviceKeyID(id.KeyAlgorithmEd25519, t.client.DeviceID)] != string(t.helper.Machine().OwnIdentity().SigningKey) {
		return false
	}
	valid, err = signatures.VerifySignatureJSON(device, user, selfKey.String(), selfKey)
	return err == nil && valid
}

// Bootstrap a sole bot device, or reuse its encrypted local cross-signing seeds.
// Never replace an existing account identity whose private keys are unavailable.
func (t *Transport) verifyOwnDevice(ctx context.Context) error {
	problem := "Device verification needs the existing account's cross-signing keys."
	fail := func() error {
		_ = t.store.UpdateState(t.config.ID, func(s *domain.State) error { s.DeviceVerified = false; s.VerificationError = problem; return nil })
		return errors.New(problem)
	}
	keys, err := t.ownKeys(ctx)
	if err != nil {
		return fail()
	}
	secret, err := t.store.Secrets(t.config.ID)
	if err != nil {
		return fail()
	}
	machine := t.helper.Machine()
	var cache *crypto.CrossSigningKeysCache
	if len(secret.CrossSigning) > 0 {
		var seeds crypto.CrossSigningSeeds
		if json.Unmarshal(secret.CrossSigning, &seeds) != nil {
			return fail()
		}
		decoded, e := seeds.Decode()
		if e != nil {
			return fail()
		}
		cache = &decoded
		master, self := keys.MasterKeys[t.client.UserID], keys.SelfSigningKeys[t.client.UserID]
		for _, key := range master.Keys {
			if key != cache.MasterKey.PublicKey() {
				return fail()
			}
		}
		for _, key := range self.Keys {
			if key != cache.SelfSigningKey.PublicKey() {
				return fail()
			}
		}
		if err = machine.ImportCrossSigningKeys(seeds); err != nil {
			return fail()
		}
	}
	if t.selfSigned(keys) {
		return t.store.UpdateState(t.config.ID, func(s *domain.State) error { s.DeviceVerified = true; s.VerificationError = ""; return nil })
	}
	master, self := keys.MasterKeys[t.client.UserID], keys.SelfSigningKeys[t.client.UserID]
	if cache == nil {
		if len(master.Keys) > 0 || len(self.Keys) > 0 || len(keys.UserSigningKeys[t.client.UserID].Keys) > 0 || len(keys.DeviceKeys[t.client.UserID]) != 1 || secret.Password == "" {
			return fail()
		}
		cache, err = machine.GenerateCrossSigningKeys()
		if err != nil {
			return fail()
		}
		secret.CrossSigning, err = json.Marshal(cache.Seeds())
		if err != nil {
			return fail()
		}
		// Persist before the first server write, so interruption cannot lose the signing identity.
		if err = t.store.PutSecrets(t.config.ID, secret); err != nil {
			return fail()
		}
	}
	problem = "Device verification could not finish. It will retry with the same keys on reconnect."
	if len(master.Keys) == 0 || len(self.Keys) == 0 {
		err = machine.PublishCrossSigningKeys(ctx, cache, func(response *mautrix.RespUserInteractive) any {
			return &mautrix.ReqUIAuthLogin{BaseAuthData: mautrix.BaseAuthData{Type: mautrix.AuthTypePassword, Session: response.Session}, User: t.client.UserID.String(), Password: secret.Password}
		})
		if err != nil {
			return fail()
		}
	}
	if err = machine.SignOwnDevice(ctx, machine.OwnIdentity()); err != nil {
		return fail()
	}
	if err = machine.SignOwnMasterKey(ctx); err != nil {
		return fail()
	}
	keys, err = t.ownKeys(ctx)
	if err != nil || !t.selfSigned(keys) {
		return fail()
	}
	return t.store.UpdateState(t.config.ID, func(s *domain.State) error { s.DeviceVerified = true; s.VerificationError = ""; return nil })
}
