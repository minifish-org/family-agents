package pith

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/minifish-org/pith-post/internal/testutil"
	"github.com/minifish-org/pith/packages/ai"
	authtypes "github.com/minifish-org/pith/packages/ai/auth/types"
	aitypes "github.com/minifish-org/pith/packages/ai/types"
)

type subscriptionTestProvider struct {
	ai.Provider
	methods authtypes.ProviderAuth
}

func (p subscriptionTestProvider) Auth() authtypes.ProviderAuth { return p.methods }
func TestSubscriptionRefreshIsSerializedAndAuthReachesRepliesAndCompaction(t *testing.T) {
	s := testutil.Store(t)
	credentials := s.ProviderCredentials()
	ctx := context.Background()
	if _, err := credentials.Modify(ctx, "custom-openai", func(authtypes.Credential) (authtypes.Credential, error) {
		return authtypes.NewOAuthCredential("old-refresh", "old-access", 0), nil
	}, nil); err != nil {
		t.Fatal(err)
	}
	refreshes := atomic.Int32{}
	provider := subscriptionTestProvider{Provider: Catalog().GetProvider("openai"), methods: authtypes.ProviderAuth{OAuth: &authtypes.OAuthAuth{
		Refresh: func(context.Context, *authtypes.OAuthCredential) (*authtypes.OAuthCredential, error) {
			refreshes.Add(1)
			return authtypes.NewOAuthCredential("rotated-refresh", "rotated-access", float64(time.Now().Add(time.Hour).UnixMilli())), nil
		},
		ToAuth: func(_ context.Context, c *authtypes.OAuthCredential) (authtypes.ModelAuth, error) {
			bearer := "Bearer " + c.Access
			uri := "https://example.test/subscription"
			return authtypes.ModelAuth{APIKey: &c.Access, Headers: aitypes.ProviderHeaders{"X-Subscription-Auth": &bearer}, BaseURL: &uri}, nil
		},
	}}}
	model := Model{Credentials: credentials, ProviderLookup: func(string) ai.Provider { return provider }}
	var wg sync.WaitGroup
	for i := 0; i < 6; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, key, err := model.subscriptionStream(ctx, "custom-openai")
			if err != nil || key != "rotated-access" {
				t.Error("concurrent refresh failed", err)
			}
		}()
	}
	wg.Wait()
	if refreshes.Load() != 1 {
		t.Fatal("refresh token rotated concurrently")
	}
	stored, err := credentials.Read(ctx, "custom-openai", nil)
	if err != nil || stored.(*authtypes.OAuthCredential).Refresh != "rotated-refresh" {
		t.Fatal("rotated credential was not persisted")
	}
	dir := t.TempDir()
	path := filepath.Join(dir, "conversation.jsonl")
	appendCompactionHistory(t, path, 20)
	summaries, replies := 0, 0
	model.Stream = func(m *aitypes.Model, transcript *aitypes.TranscriptContext, opts *aitypes.SimpleStreamOptions) *aitypes.AssistantMessageEventStream {
		if opts.APIKey == nil || *opts.APIKey != "rotated-access" || opts.Headers["X-Subscription-Auth"] == nil || *opts.Headers["X-Subscription-Auth"] != "Bearer rotated-access" || m.BaseUrl != "https://example.test/subscription" {
			t.Error("subscription auth not bound to request")
		}
		if m.Headers["X-Subscription-Auth"] != "" {
			t.Error("secret auth copied into serializable model metadata")
		}
		if isSummaryRequest(transcript) {
			summaries++
			return compactionResponse(m, "Subscription summary", aitypes.StopReasonStop)
		}
		replies++
		return compactionResponse(m, "Subscription reply", aitypes.StopReasonStop)
	}
	c := compactionConfig()
	c.ModelProvider = "custom-openai"
	c.ModelAuth = "oauth"
	result, err := model.Generate(ctx, c, path, dir, "Continue", "DO_NOT_FALL_BACK_TO_THIS_API_KEY")
	if err != nil || len(result) != 1 || result[0].Text != "Subscription reply" || summaries != 1 || replies != 1 {
		t.Fatal("subscription did not handle summary and reply", err)
	}
	if err = credentials.Delete(ctx, "custom-openai", nil); err != nil {
		t.Fatal(err)
	}
	if _, err = model.Generate(ctx, c, path, dir, "Must require login", "DO_NOT_FALL_BACK_TO_THIS_API_KEY"); err == nil {
		t.Fatal("logged-out subscription used an API key fallback")
	}
}
func TestFailedSubscriptionRefreshKeepsCredentialAndDoesNotExposeProviderErrors(t *testing.T) {
	s := testutil.Store(t)
	credentials := s.ProviderCredentials()
	ctx := context.Background()
	_, _ = credentials.Modify(ctx, "anthropic", func(authtypes.Credential) (authtypes.Credential, error) {
		return authtypes.NewOAuthCredential("private-refresh", "private-access", 0), nil
	}, nil)
	provider := subscriptionTestProvider{Provider: Catalog().GetProvider("anthropic"), methods: authtypes.ProviderAuth{OAuth: &authtypes.OAuthAuth{Refresh: func(context.Context, *authtypes.OAuthCredential) (*authtypes.OAuthCredential, error) {
		return nil, errors.New("private-refresh private-access")
	}}}}
	model := Model{Credentials: credentials, ProviderLookup: func(string) ai.Provider { return provider }}
	_, _, err := model.subscriptionStream(ctx, "anthropic")
	if err == nil || strings.Contains(err.Error(), "private-") {
		t.Fatal("refresh error leaked credential data")
	}
	kept, _ := credentials.Read(ctx, "anthropic", nil)
	raw, _ := json.Marshal(kept)
	if !strings.Contains(string(raw), "private-refresh") {
		t.Fatal("failed refresh destroyed original credential")
	}
}
