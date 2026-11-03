package pith

import (
	"sort"
	"strings"
	"sync"

	"github.com/minifish-org/pith/packages/ai"
	"github.com/minifish-org/pith/packages/ai/providers"
	aitypes "github.com/minifish-org/pith/packages/ai/types"
	codingagent "github.com/minifish-org/pith/packages/coding-agent"
)

var catalogOnce sync.Once
var modelCatalog ai.Models

func Catalog() ai.Models {
	catalogOnce.Do(func() { modelCatalog = providers.BuiltinModels(nil) })
	return modelCatalog
}

type CatalogModel struct {
	ID              string   `json:"id"`
	Name            string   `json:"name"`
	Thinking        []string `json:"thinking"`
	DefaultThinking string   `json:"default_thinking"`
}
type CatalogAuth struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}
type CatalogProvider struct {
	Auth         []CatalogAuth  `json:"auth"`
	ID           string         `json:"id"`
	Name         string         `json:"name"`
	Models       []CatalogModel `json:"models"`
	DefaultModel string         `json:"default_model"`
	Custom       bool           `json:"custom"`
}

func ThinkingLevels(model aitypes.Model) []string {
	result := []string{}
	for _, level := range ai.GetSupportedThinkingLevels(model) {
		result = append(result, string(level))
	}
	return result
}
func ProviderCatalog() []CatalogProvider {
	result := []CatalogProvider{}
	for _, provider := range Catalog().GetProviders() {
		if provider.Auth().APIKey == nil && provider.Auth().OAuth == nil {
			continue
		}
		p := CatalogProvider{ID: provider.ID(), Name: provider.Name(), DefaultModel: codingagent.DefaultModelPerProvider[provider.ID()], Models: []CatalogModel{}}
		if provider.Auth().OAuth != nil {
			p.Auth = append(p.Auth, CatalogAuth{ID: "oauth", Name: provider.Auth().OAuth.Name})
		}
		if provider.Auth().APIKey != nil {
			p.Auth = append(p.Auth, CatalogAuth{ID: "api_key", Name: "API key"})
		}
		for _, m := range Catalog().GetModels(provider.ID()) {
			if !strings.HasPrefix(m.BaseUrl, "https://") || strings.ContainsAny(m.BaseUrl, "{}") {
				continue
			}
			p.Models = append(p.Models, CatalogModel{ID: m.Id, Name: m.Name, Thinking: ThinkingLevels(m), DefaultThinking: string(ai.ClampThinkingLevel(m, aitypes.ModelThinkingLevel(codingagent.DefaultThinkingLevel)))})
		}
		if len(p.Models) > 0 {
			sort.Slice(p.Models, func(i, j int) bool { return p.Models[i].Name < p.Models[j].Name })
			result = append(result, p)
		}
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Name < result[j].Name })
	for _, p := range []CatalogProvider{{ID: "custom-openai", Name: "OpenAI-compatible service", Custom: true}, {ID: "custom-responses", Name: "OpenAI Responses-compatible service", Custom: true}, {ID: "custom-anthropic", Name: "Anthropic-compatible service", Custom: true}} {
		p.Models = []CatalogModel{}
		p.Auth = []CatalogAuth{{ID: "api_key", Name: "API key"}}
		result = append(result, p)
	}
	return result
}
func CustomAPI(provider string) string {
	switch provider {
	case "custom-openai":
		return "openai-completions"
	case "custom-responses":
		return "openai-responses"
	case "custom-anthropic":
		return "anthropic-messages"
	}
	return ""
}
