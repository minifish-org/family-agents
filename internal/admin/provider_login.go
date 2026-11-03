package admin

import (
	"context"
	"errors"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/minifish-org/pith-post/internal/agent"
	"github.com/minifish-org/pith-post/internal/pith"
	"github.com/minifish-org/pith/packages/ai"
	authtypes "github.com/minifish-org/pith/packages/ai/auth/types"
	"github.com/pocketbase/pocketbase/core"
)

type loginPrompt struct {
	ID          string        `json:"id"`
	Type        string        `json:"type"`
	Message     string        `json:"message"`
	Placeholder string        `json:"placeholder"`
	Options     []loginOption `json:"options"`
}
type loginOption struct {
	ID    string `json:"id"`
	Label string `json:"label"`
}
type loginView struct {
	ID       string       `json:"id"`
	Provider string       `json:"provider"`
	Status   string       `json:"status"`
	URL      string       `json:"url"`
	Code     string       `json:"code"`
	Message  string       `json:"message"`
	Prompt   *loginPrompt `json:"prompt,omitempty"`
}
type providerLogin struct {
	mu           sync.Mutex
	owner        string
	chooseMethod bool
	created      time.Time
	view         loginView
	cancel       context.CancelFunc
	answers      chan string
}
type providerLogins struct {
	mu      sync.Mutex
	flows   map[string]*providerLogin
	manager *agent.Manager
	lookup  func(string) ai.Provider
}

func newProviderLogins(manager *agent.Manager, lookup func(string) ai.Provider) *providerLogins {
	if lookup == nil {
		lookup = pith.Catalog().GetProvider
	}
	return &providerLogins{flows: map[string]*providerLogin{}, manager: manager, lookup: lookup}
}
func (f *providerLogin) snapshot() loginView { f.mu.Lock(); defer f.mu.Unlock(); return f.view }
func (f *providerLogin) stop() {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.view.Status == "pending" || f.view.Status == "waiting" {
		f.view.Status = "cancelled"
		f.view.Message = "Sign-in cancelled."
		f.view.Prompt = nil
		f.view.URL = ""
		f.view.Code = ""
		if f.cancel != nil {
			f.cancel()
		}
	}
}
func (s *providerLogins) find(id, owner string) *providerLogin {
	s.mu.Lock()
	defer s.mu.Unlock()
	f := s.flows[id]
	if f == nil || f.owner != owner {
		return nil
	}
	return f
}
func (s *providerLogins) cancelProvider(provider string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, f := range s.flows {
		if f.view.Provider == provider {
			f.stop()
		}
	}
}
func (s *providerLogins) latest(owner string) *loginView {
	s.mu.Lock()
	defer s.mu.Unlock()
	var latest *providerLogin
	for _, f := range s.flows {
		if f.owner == owner && (latest == nil || f.created.After(latest.created)) {
			latest = f
		}
	}
	if latest == nil {
		return nil
	}
	v := latest.snapshot()
	if v.Status == "pending" || v.Status == "waiting" {
		return &v
	}
	return nil
}
func publicAuthURL(value string) string {
	u, err := url.Parse(value)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil {
		return ""
	}
	return value
}
func (f *providerLogin) notify(event authtypes.AuthEvent) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.view.Status != "pending" && f.view.Status != "waiting" {
		return
	}
	if event.Message != nil {
		f.view.Message = *event.Message
	}
	if event.Instructions != nil {
		f.view.Message = *event.Instructions
	}
	if event.URL != nil {
		f.view.URL = publicAuthURL(*event.URL)
	}
	if event.VerificationURI != nil {
		f.view.URL = publicAuthURL(*event.VerificationURI)
	}
	if event.UserCode != nil {
		f.view.Code = *event.UserCode
	}
	for _, link := range event.Links {
		if u := publicAuthURL(link.URL); u != "" {
			f.view.URL = u
			break
		}
	}
}
func (f *providerLogin) prompt(ctx context.Context, p authtypes.AuthPrompt) (string, error) {
	// Pith's remote-friendly methods avoid callbacks to the operator's localhost.
	if !f.chooseMethod && p.Type == authtypes.AuthPromptSelect {
		for _, option := range p.Options {
			if option.ID == "device_code" || option.ID == "copy_code" {
				return option.ID, nil
			}
		}
	}
	view := &loginPrompt{ID: randomID(), Type: p.Type, Message: p.Message, Options: []loginOption{}}
	if p.Placeholder != nil {
		view.Placeholder = *p.Placeholder
	}
	for _, o := range p.Options {
		view.Options = append(view.Options, loginOption{ID: o.ID, Label: o.Label})
	}
	answers := make(chan string, 1)
	f.mu.Lock()
	if f.view.Status == "cancelled" {
		f.mu.Unlock()
		return "", context.Canceled
	}
	f.view.Status = "waiting"
	f.view.Prompt = view
	f.answers = answers
	f.mu.Unlock()
	select {
	case <-ctx.Done():
		return "", ctx.Err()
	case value := <-answers:
		return value, nil
	}
}
func (s *providerLogins) start(owner, providerID string, chooseMethod bool) (*providerLogin, error) {
	provider := s.lookup(providerID)
	if provider == nil || provider.Auth().OAuth == nil {
		return nil, errors.New("provider does not support subscription sign-in")
	}
	f := &providerLogin{owner: owner, chooseMethod: chooseMethod, created: time.Now(), view: loginView{ID: randomID(), Provider: providerID, Status: "pending", Message: "Starting sign-in…"}}
	s.mu.Lock()
	for id, old := range s.flows {
		if time.Since(old.created) > 15*time.Minute {
			old.stop()
			delete(s.flows, id)
		} else if old.owner == owner {
			old.stop()
		}
	}
	s.flows[f.view.ID] = f
	s.mu.Unlock()
	s.manager.Background(func(parent context.Context) {
		ctx, cancel := context.WithTimeout(parent, 10*time.Minute)
		defer cancel()
		f.mu.Lock()
		if f.view.Status == "cancelled" {
			f.mu.Unlock()
			return
		}
		f.cancel = cancel
		f.mu.Unlock()
		interaction := authtypes.NewInteraction(ctx, f.prompt, f.notify)
		oauth := provider.Auth().OAuth
		var credential *authtypes.OAuthCredential
		var err error
		if oauth.LoginWithOptions != nil {
			var device string
			device, err = s.manager.Store.ProviderDeviceID()
			if err == nil {
				credential, err = oauth.LoginWithOptions(ctx, interaction, &authtypes.LoginOptions{GetDeviceID: func() string { return device }})
			}
		} else if oauth.Login != nil {
			credential, err = oauth.Login(ctx, interaction)
		} else {
			err = errors.New("login is unavailable")
		}
		if err == nil && credential != nil && credential.Access != "" {
			_, err = s.manager.Store.ProviderCredentials().Modify(ctx, providerID, func(authtypes.Credential) (authtypes.Credential, error) {
				f.mu.Lock()
				defer f.mu.Unlock()
				if f.view.Status == "cancelled" {
					return nil, context.Canceled
				}
				return credential, nil
			}, nil)
		} else if err == nil {
			err = errors.New("login returned no credential")
		}
		f.mu.Lock()
		defer f.mu.Unlock()
		f.view.Prompt = nil
		f.view.URL = ""
		f.view.Code = ""
		f.answers = nil
		if f.view.Status == "cancelled" {
			return
		}
		if err != nil {
			f.view.Status = "failed"
			f.view.Message = "Sign-in did not finish. Try again."
		} else {
			f.view.Status = "succeeded"
			f.view.Message = "Signed in."
		}
	})
	return f, nil
}
func (a Admin) startProviderLogin(e *core.RequestEvent) error {
	var in struct {
		Provider     string `json:"provider"`
		ChooseMethod bool   `json:"choose_method"`
	}
	if err := decode(e, &in); err != nil {
		return err
	}
	f, err := a.Logins.start(e.Auth.Id, in.Provider, in.ChooseMethod)
	if err != nil {
		return e.BadRequestError("Choose a provider with subscription sign-in.", nil)
	}
	return e.JSON(200, f.snapshot())
}
func (a Admin) getProviderLogin(e *core.RequestEvent) error {
	f := a.Logins.find(e.Request.PathValue("id"), e.Auth.Id)
	if f == nil {
		return e.NotFoundError("Sign-in not found.", nil)
	}
	return e.JSON(200, f.snapshot())
}
func (a Admin) answerProviderLogin(e *core.RequestEvent) error {
	var in struct {
		Prompt string `json:"prompt"`
		Answer string `json:"answer"`
	}
	if err := decode(e, &in); err != nil {
		return err
	}
	if strings.TrimSpace(in.Answer) == "" || len(in.Answer) > 16384 {
		return e.BadRequestError("Enter the requested sign-in value.", nil)
	}
	f := a.Logins.find(e.Request.PathValue("id"), e.Auth.Id)
	if f == nil {
		return e.NotFoundError("Sign-in not found.", nil)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.view.Status != "waiting" || f.view.Prompt == nil || f.view.Prompt.ID != in.Prompt || f.answers == nil {
		return e.BadRequestError("This sign-in step changed. Try again.", nil)
	}
	if f.view.Prompt.Type == authtypes.AuthPromptSelect {
		valid := false
		for _, o := range f.view.Prompt.Options {
			if o.ID == in.Answer {
				valid = true
			}
		}
		if !valid {
			return e.BadRequestError("Choose a sign-in option.", nil)
		}
	}
	f.answers <- in.Answer
	f.answers = nil
	f.view.Prompt = nil
	f.view.Status = "pending"
	f.view.Message = "Completing sign-in…"
	return e.JSON(200, map[string]bool{"ok": true})
}
func (a Admin) cancelProviderLogin(e *core.RequestEvent) error {
	f := a.Logins.find(e.Request.PathValue("id"), e.Auth.Id)
	if f == nil {
		return e.NotFoundError("Sign-in not found.", nil)
	}
	f.stop()
	return e.JSON(200, f.snapshot())
}
func (a Admin) logoutProvider(e *core.RequestEvent) error {
	var in struct {
		Provider string `json:"provider"`
	}
	if err := decode(e, &in); err != nil {
		return err
	}
	a.Logins.cancelProvider(in.Provider)
	if err := a.Manager.Store.ProviderCredentials().Delete(e.Request.Context(), in.Provider, nil); err != nil {
		return e.BadRequestError("Could not sign out of this provider.", nil)
	}
	return e.JSON(200, map[string]bool{"ok": true})
}
