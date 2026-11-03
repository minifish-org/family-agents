package admin

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"

	"github.com/minifish-org/pith-post/internal/pith"
	"github.com/minifish-org/pith-post/internal/store"
	"github.com/minifish-org/pith/packages/ai"
	authtypes "github.com/minifish-org/pith/packages/ai/auth/types"
	aitypes "github.com/minifish-org/pith/packages/ai/types"
	codingagent "github.com/minifish-org/pith/packages/coding-agent"
	"github.com/pocketbase/pocketbase/core"
)

func connectionProvider(c store.Connection) string {
	if c.Provider != "" {
		return c.Provider
	}
	switch c.API {
	case "anthropic-messages":
		return "custom-anthropic"
	case "openai-responses":
		return "custom-responses"
	}
	return "custom-openai"
}
func modelRevision(app core.App) (string, error) {
	var rows []struct {
		ID     string `db:"id"`
		Value  string `db:"value"`
		Secret []byte `db:"secret"`
	}
	if err := app.DB().NewQuery(`SELECT id,value,secret FROM post_connections ORDER BY id`).All(&rows); err != nil {
		return "", err
	}
	raw := []string{}
	for _, r := range rows {
		raw = append(raw, r.ID, r.Value, hex.EncodeToString(r.Secret))
	}
	selected, err := store.GlobalConnection(app)
	if err != nil {
		return "", err
	}
	raw = append(raw, selected)
	encoded, _ := json.Marshal(raw)
	return digest(string(encoded)), nil
}
func (a Admin) modelCatalog(e *core.RequestEvent) error {
	catalog := pith.ProviderCatalog()
	for index, entry := range catalog {
		if entry.Custom {
			continue
		}
		credential, err := a.Manager.Store.ProviderCredentials().Read(e.Request.Context(), entry.ID, nil)
		if err != nil {
			return e.InternalServerError("Could not load provider models.", nil)
		}
		provider := pith.Catalog().GetProvider(entry.ID)
		if a.ProviderLookup != nil {
			provider = a.ProviderLookup(entry.ID)
		}
		if credential == nil || provider == nil || !provider.SupportsFilterModels() {
			continue
		}
		allowed := map[string]bool{}
		for _, m := range provider.FilterModels(provider.GetModels(), credential) {
			allowed[m.Id] = true
		}
		catalog[index].Models = []pith.CatalogModel{}
		for _, m := range entry.Models {
			if allowed[m.ID] {
				catalog[index].Models = append(catalog[index].Models, m)
			}
		}
	}
	return e.JSON(200, catalog)
}
func (a Admin) modelSettings(e *core.RequestEvent) error {
	defaults, err := setupDefaults(e.App)
	if err != nil {
		return e.InternalServerError("Could not load model settings.", nil)
	}
	connections, err := a.Manager.Store.Connections()
	if err != nil {
		return e.InternalServerError("Could not load providers.", nil)
	}
	var current *store.Connection
	for i := range connections {
		connections[i].Provider = connectionProvider(connections[i])
		if connections[i].Auth == "" {
			connections[i].Auth = "api_key"
		}
		if connections[i].Thinking == "" {
			connections[i].Thinking = "off"
		}
		if connections[i].ID == defaults.Connection {
			current = &connections[i]
		}
	}
	revision, err := modelRevision(e.App)
	if err != nil {
		return e.InternalServerError("Could not load model settings.", nil)
	}
	credentials, err := a.Manager.Store.ProviderCredentials().List(e.Request.Context(), nil)
	if err != nil {
		return e.InternalServerError("Could not load subscription status.", nil)
	}
	return e.JSON(200, map[string]any{"current": current, "saved": connections, "revision": revision, "credentials": credentials, "login": a.Logins.latest(e.Auth.Id)})
}
func (a Admin) saveModelSettings(e *core.RequestEvent) error {
	var in struct {
		Provider   string  `json:"provider"`
		Auth       string  `json:"auth"`
		Model      string  `json:"model"`
		Thinking   string  `json:"thinking"`
		URL        string  `json:"url"`
		Key        *string `json:"key"`
		Connection string  `json:"connection"`
		Revision   string  `json:"revision"`
	}
	if err := decode(e, &in); err != nil {
		return err
	}
	in.Model = strings.TrimSpace(in.Model)
	in.URL = strings.TrimRight(strings.TrimSpace(in.URL), "/")
	if in.Key != nil && *in.Key == "" {
		in.Key = nil
	}
	var provider *pith.CatalogProvider
	for _, p := range pith.ProviderCatalog() {
		if p.ID == in.Provider {
			copy := p
			provider = &copy
			break
		}
	}
	if provider == nil {
		return e.BadRequestError("Choose a supported provider.", nil)
	}
	if in.Auth == "" {
		in.Auth = "api_key"
		if len(provider.Auth) == 1 {
			in.Auth = provider.Auth[0].ID
		}
	}
	authAllowed := false
	for _, method := range provider.Auth {
		if method.ID == in.Auth {
			authAllowed = true
		}
	}
	if !authAllowed {
		return e.BadRequestError("Choose a supported sign-in method.", nil)
	}
	if in.Auth == "oauth" {
		in.Key = nil
	}
	c := store.Connection{ID: "provider-" + in.Provider, Name: provider.Name, Model: in.Model, Provider: in.Provider, Thinking: in.Thinking, Auth: in.Auth}
	var levels []string
	if provider.Custom {
		c.API = pith.CustomAPI(in.Provider)
		c.URL = in.URL
		c.Context = 128000
		c.MaxTokens = 4096
		levels = pith.ThinkingLevels(aitypes.Model{Reasoning: true})
	} else {
		model := pith.Catalog().GetModel(in.Provider, in.Model)
		allowed := false
		for _, m := range provider.Models {
			if m.ID == in.Model {
				allowed = true
				break
			}
		}
		if model == nil || !allowed {
			return e.BadRequestError("Choose a model from this provider's Pith catalog.", nil)
		}
		c.API = string(model.Api)
		c.URL = model.BaseUrl
		c.Context = int(model.ContextWindow)
		c.MaxTokens = int(model.MaxTokens)
		levels = pith.ThinkingLevels(*model)
		if c.Thinking == "" {
			c.Thinking = string(ai.ClampThinkingLevel(*model, aitypes.ModelThinkingLevel(codingagent.DefaultThinkingLevel)))
		}
	}
	if c.Thinking == "" {
		c.Thinking = "off"
	}
	allowed := false
	for _, level := range levels {
		if level == c.Thinking {
			allowed = true
			break
		}
	}
	if !allowed {
		return e.BadRequestError("Choose a thinking level supported by this model.", nil)
	}
	conflict := false
	err := e.App.RunInTransaction(func(app core.App) error {
		revision, err := modelRevision(app)
		if err != nil {
			return err
		}
		if revision != in.Revision {
			conflict = true
			return errors.New("model settings changed")
		}
		tx := a.Manager.Store.WithApp(app)
		if in.Connection != "" {
			previous, err := tx.Connection(in.Connection)
			if err != nil || connectionProvider(previous) != in.Provider {
				return errors.New("saved provider does not match")
			}
			c.ID = previous.ID
			if provider.Custom {
				c.Context = previous.Context
				c.MaxTokens = previous.MaxTokens
			}
		}
		previous, previousErr := tx.Connection(c.ID)
		if in.Auth == "oauth" {
			credential, err := tx.ProviderCredentials().Read(e.Request.Context(), in.Provider, nil)
			if err != nil || credential == nil || credential.CredentialType() != authtypes.CredentialTypeOAuth {
				return errors.New("sign in to this subscription provider first")
			}
		}
		if in.Auth == "api_key" && !provider.Custom && in.Key == nil && (previousErr != nil || !previous.KeySet) {
			return errors.New("enter an API key for this provider")
		}
		if err = tx.SaveConnection(c, in.Key); err != nil {
			return err
		}
		return tx.SelectGlobalConnection(c.ID)
	})
	if conflict {
		return e.JSON(409, map[string]string{"message": "Model settings changed in another session. Reopen Settings before saving."})
	}
	if err != nil {
		return e.BadRequestError("Could not save model settings. Check the selected model, sign-in status and service address.", nil)
	}
	return e.JSON(200, map[string]bool{"ok": true})
}
