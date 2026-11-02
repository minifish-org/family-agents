// Package pith embeds the coding-agent SDK directly, with no active tools or resource discovery.
package pith

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/minifish-org/pith-post/internal/domain"
	agenttypes "github.com/minifish-org/pith/packages/agent/types"
	aitypes "github.com/minifish-org/pith/packages/ai/types"
	codingagent "github.com/minifish-org/pith/packages/coding-agent"
)

const deliveryInstructions = `
You are connected to your owner through Pith Post. Reply with ordinary text.
If an image or file is requested and you can supply its actual bytes, you may instead return only a JSON object with a "pith_post" array of content items:
{"pith_post":[{"kind":"text","text":"A caption"},{"kind":"file","name":"note.txt","mime":"text/plain","data":"BASE64_BYTES"}]}
Use kind "image" for PNG, JPEG, GIF, or WebP. Supply actual base64 bytes, not a path or URL. Do not claim to have read files or used tools; no tools are available. Never include a destination room or user. The host selects the authorized recipient. Keep ordinary text below 24000 UTF-8 bytes and attachments below 8 MiB each.`

type Model struct{ Stream agenttypes.StreamFn }

type executionError struct{ cause error }

func (e executionError) Error() string { return "Pith execution failed; review required" }
func (e executionError) Unwrap() error { return e.cause }

func (m Model) Generate(ctx context.Context, c domain.Config, path, workspace, input, key string) ([]domain.Content, error) {
	manager, err := codingagent.OpenSession(path)
	if err != nil {
		return nil, errors.New("cannot open persistent conversation")
	}
	defer manager.Close()
	// Explicit non-nil empty allowlist: nil would enable file and shell tools.
	tools, err := codingagent.NewToolRegistry(workspace, nil, []string{}, nil, codingagent.ToolHooks{})
	if err != nil {
		return nil, err
	}
	defer tools.CloseTools()
	if len(tools.Names()) != 0 {
		return nil, errors.New("chat-only tool policy violated")
	}
	if key == "" {
		key = "local-no-key"
	} // Do not fall back to ambient provider credentials.
	model := &aitypes.Model{Id: c.Model, Name: c.Model, Api: aitypes.Api(c.ModelAPI), Provider: aitypes.ProviderId("pith-post"), BaseUrl: c.ModelURL, Input: []aitypes.ModelInputModality{aitypes.ModelInputText}, MaxTokens: float64(c.MaxTokens), ContextWindow: float64(c.ContextWindow)}
	session, err := codingagent.CreateAgentSessionFromServices(codingagent.CreateAgentSessionFromServicesOptions{
		Services: codingagent.AgentSessionServices{Cwd: workspace, Manager: manager, Tools: tools, Resources: codingagent.ResourceSet{SystemPrompt: c.Prompt + "\n" + deliveryInstructions}},
		Model:    codingagent.ModelOptions{Model: model, ThinkingLevel: agenttypes.ThinkingOff, APIKey: func(context.Context, string) (string, error) { return key, nil }, StreamFn: m.Stream},
		// The pinned SDK treats reaching MaxTurns as an error, even on a final answer.
		Policy: codingagent.RunPolicy{MaxTurns: 2, RetryAttempts: 0},
	})
	if err != nil {
		return nil, errors.New("cannot initialize Pith session")
	}
	defer session.Close()
	expand := false
	result, err := session.Prompt(ctx, input, codingagent.PromptOptions{ExpandPromptTemplates: &expand})
	if err != nil {
		return nil, executionError{cause: err}
	}
	var text strings.Builder
	for _, msg := range result.Messages {
		if msg.Message == nil || msg.Message.Assistant == nil {
			continue
		}
		for _, block := range msg.Message.Assistant.Content {
			if block.Text != nil {
				text.WriteString(block.Text.Text)
			}
		}
	}
	return ParseContent(text.String())
}

func ParseContent(text string) ([]domain.Content, error) {
	var envelope struct {
		Items []domain.Content `json:"pith_post"`
	}
	if strings.HasPrefix(strings.TrimSpace(text), "{") && json.Unmarshal([]byte(text), &envelope) == nil && envelope.Items != nil {
		if len(envelope.Items) == 0 || len(envelope.Items) > 8 {
			return nil, errors.New("invalid content item count")
		}
		for _, item := range envelope.Items {
			if err := item.Validate(); err != nil {
				return nil, err
			}
		}
		return envelope.Items, nil
	}
	content := domain.Content{Kind: "text", Text: text}
	if err := content.Validate(); err != nil {
		return nil, err
	}
	return []domain.Content{content}, nil
}
