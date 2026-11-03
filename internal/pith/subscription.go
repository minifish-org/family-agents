package pith

import (
	"context"
	"errors"

	agenttypes "github.com/minifish-org/pith/packages/agent/types"
	"github.com/minifish-org/pith/packages/ai/auth"
	authtypes "github.com/minifish-org/pith/packages/ai/auth/types"
	aitypes "github.com/minifish-org/pith/packages/ai/types"
)

type noAmbientAuth struct{}

func (noAmbientAuth) Env(string) (*string, error)     { return nil, nil }
func (noAmbientAuth) FileExists(string) (bool, error) { return false, nil }

func (m Model) subscriptionStream(ctx context.Context, providerID string) (agenttypes.StreamFn, string, error) {
	if m.Credentials == nil {
		return nil, "", errors.New("sign in to the selected subscription provider")
	}
	provider := Catalog().GetProvider(providerID)
	if m.ProviderLookup != nil {
		provider = m.ProviderLookup(providerID)
	}
	if provider == nil || provider.Auth().OAuth == nil {
		return nil, "", errors.New("subscription provider is unavailable")
	}
	credential, err := m.Credentials.Read(ctx, providerID, nil)
	if ctx.Err() != nil {
		return nil, "", ctx.Err()
	}
	if err != nil || credential == nil || credential.CredentialType() != authtypes.CredentialTypeOAuth {
		return nil, "", errors.New("sign in to the selected subscription provider")
	}
	resolved, err := auth.ResolveProviderAuth(ctx, auth.AuthProviderSpec{ID: providerID, Auth: authtypes.ProviderAuth{OAuth: provider.Auth().OAuth}}, m.Credentials, noAmbientAuth{}, nil)
	if ctx.Err() != nil {
		return nil, "", ctx.Err()
	}
	if err != nil || resolved == nil {
		return nil, "", errors.New("subscription authorization failed; sign in again")
	}
	key := ""
	if resolved.Auth.APIKey != nil {
		key = *resolved.Auth.APIKey
	}
	base := m.Stream
	return func(model *aitypes.Model, transcript *aitypes.TranscriptContext, options *aitypes.SimpleStreamOptions) *aitypes.AssistantMessageEventStream {
		opts := *options
		opts.APIKey = resolved.Auth.APIKey
		opts.Env = resolved.Env
		opts.Headers = aitypes.ProviderHeaders{}
		for k, v := range options.Headers {
			opts.Headers[k] = v
		}
		for k, v := range resolved.Auth.Headers {
			opts.Headers[k] = v
		}
		retries := 0
		opts.MaxRetries = &retries
		copy := *model
		if resolved.Auth.BaseURL != nil {
			copy.BaseUrl = *resolved.Auth.BaseURL
		}
		stream := base
		if stream == nil {
			stream = streamForAPI(copy.Api)
		}
		if stream == nil {
			return nil
		}
		return stream(&copy, transcript, &opts)
	}, key, nil
}
