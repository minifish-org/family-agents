package store

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"

	authtypes "github.com/minifish-org/pith/packages/ai/auth/types"
	"github.com/pocketbase/dbx"
)

type ProviderCredentials struct{ Store *Store }

func (s *Store) ProviderCredentials() *ProviderCredentials { return &ProviderCredentials{Store: s} }
func (p *ProviderCredentials) Read(ctx context.Context, id string, _ *authtypes.AuthOperationOptions) (authtypes.Credential, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	var encrypted []byte
	err := p.Store.App.DB().NewQuery(`SELECT value FROM post_provider_credentials WHERE provider={:id}`).Bind(dbx.Params{"id": id}).Row(&encrypted)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	raw, err := p.Store.open("provider:"+id, encrypted)
	if err != nil {
		return nil, err
	}
	var tag struct {
		Type string `json:"type"`
	}
	if err = json.Unmarshal(raw, &tag); err != nil {
		return nil, err
	}
	switch tag.Type {
	case authtypes.CredentialTypeOAuth:
		var c authtypes.OAuthCredential
		err = json.Unmarshal(raw, &c)
		return &c, err
	case authtypes.CredentialTypeAPIKey:
		var c authtypes.ApiKeyCredential
		err = json.Unmarshal(raw, &c)
		return &c, err
	}
	return nil, errors.New("unknown provider credential type")
}
func (p *ProviderCredentials) List(ctx context.Context, options *authtypes.AuthOperationOptions) ([]authtypes.CredentialInfo, error) {
	var rows []struct {
		ID string `db:"provider"`
	}
	if err := p.Store.App.DB().NewQuery(`SELECT provider FROM post_provider_credentials ORDER BY provider`).All(&rows); err != nil {
		return nil, err
	}
	result := []authtypes.CredentialInfo{}
	for _, row := range rows {
		c, err := p.Read(ctx, row.ID, options)
		if err != nil {
			return nil, err
		}
		if c != nil {
			result = append(result, authtypes.CredentialInfo{ProviderID: row.ID, Type: c.CredentialType()})
		}
	}
	return result, nil
}
func (p *ProviderCredentials) Modify(ctx context.Context, id string, fn func(authtypes.Credential) (authtypes.Credential, error), options *authtypes.AuthOperationOptions) (authtypes.Credential, error) {
	unlock := p.Store.LockProfile("provider:" + id)
	defer unlock()
	current, err := p.Read(ctx, id, options)
	if err != nil {
		return nil, err
	}
	next, err := fn(current)
	if err != nil {
		return nil, err
	}
	if err = ctx.Err(); err != nil {
		return nil, err
	}
	if next == nil {
		return current, nil
	}
	raw, err := json.Marshal(next)
	if err != nil {
		return nil, err
	}
	_, err = p.Store.App.DB().NewQuery(`INSERT INTO post_provider_credentials(provider,value) VALUES({:id},{:v}) ON CONFLICT(provider) DO UPDATE SET value=excluded.value`).Bind(dbx.Params{"id": id, "v": p.Store.seal("provider:"+id, raw)}).Execute()
	return next, err
}
func (p *ProviderCredentials) Delete(ctx context.Context, id string, _ *authtypes.AuthOperationOptions) error {
	unlock := p.Store.LockProfile("provider:" + id)
	defer unlock()
	if err := ctx.Err(); err != nil {
		return err
	}
	_, err := p.Store.App.DB().NewQuery(`DELETE FROM post_provider_credentials WHERE provider={:id}`).Bind(dbx.Params{"id": id}).Execute()
	return err
}
func (s *Store) ProviderDeviceID() (string, error) {
	var id string
	// Use a random, installation-scoped value, independent of every Matrix device.
	value := make([]byte, 24)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	_, err := s.App.DB().NewQuery(`INSERT OR IGNORE INTO post_settings(name,value) VALUES('provider_device_id',{:v})`).Bind(dbx.Params{"v": hex.EncodeToString(value)}).Execute()
	if err != nil {
		return "", err
	}
	err = s.App.DB().NewQuery(`SELECT value FROM post_settings WHERE name='provider_device_id'`).Row(&id)
	return id, err
}
