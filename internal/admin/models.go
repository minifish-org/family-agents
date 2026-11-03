package admin

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"

	"github.com/minifish-org/pith-post/internal/pith"
	"github.com/minifish-org/pith-post/internal/store"
	"github.com/minifish-org/pith/packages/ai"
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
func (a Admin) modelCatalog(e *core.RequestEvent) error { return e.JSON(200, pith.ProviderCatalog()) }
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
	return e.JSON(200, map[string]any{"current": current, "saved": connections, "revision": revision})
}
func (a Admin) saveModelSettings(e *core.RequestEvent) error {
	var in struct {
		Provider   string  `json:"provider"`
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
	c := store.Connection{ID: "provider-" + in.Provider, Name: provider.Name, Model: in.Model, Provider: in.Provider, Thinking: in.Thinking}
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
		if !provider.Custom && in.Key == nil && (previousErr != nil || !previous.KeySet) {
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
		return e.BadRequestError("Could not save model settings. Check the provider, model, service address and API key.", nil)
	}
	return e.JSON(200, map[string]bool{"ok": true})
}
