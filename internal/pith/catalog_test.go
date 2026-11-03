package pith

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/minifish-org/pith-post/internal/domain"
	aitypes "github.com/minifish-org/pith/packages/ai/types"
)

func TestCatalogAndThinkingAreUsedByTheRealSDK(t *testing.T) {
	listed := map[string]bool{}
	for _, p := range ProviderCatalog() {
		listed[p.ID] = true
	}
	for _, id := range []string{"openai", "anthropic", "google", "deepseek", "custom-openai"} {
		if !listed[id] {
			t.Fatalf("Pith provider %s missing", id)
		}
	}
	known := Catalog().GetModels("openai")[0]
	for _, m := range Catalog().GetModels("openai") {
		if m.Reasoning {
			known = m
			break
		}
	}
	level := "off"
	for _, candidate := range ThinkingLevels(known) {
		if candidate == "high" {
			level = candidate
		}
	}
	if level != "high" {
		t.Fatal("test needs a reasoning model")
	}
	calls := 0
	model := Model{Stream: func(m *aitypes.Model, transcript *aitypes.TranscriptContext, options *aitypes.SimpleStreamOptions) *aitypes.AssistantMessageEventStream {
		calls++
		if string(m.Provider) != "openai" || m.Api != known.Api || m.Id != known.Id || m.MaxTokens != known.MaxTokens {
			t.Error("SDK native model metadata changed")
		}
		if options.Reasoning == nil || string(*options.Reasoning) != level {
			t.Error("selected thinking level did not reach the SDK stream")
		}
		message := aitypes.NewAssistantMessage(m.Api, m.Provider, m.Id, 1)
		message.Content = []aitypes.ContentBlock{aitypes.TextBlock("Configured model replied.")}
		message.StopReason = aitypes.StopReasonStop
		stream := aitypes.NewAssistantMessageEventStream()
		stream.Push(aitypes.NewDoneEvent(aitypes.StopReasonStop, message))
		return stream
	}}
	dir := t.TempDir()
	c := domain.Config{Prompt: "Persona kept", ModelProvider: "openai", Model: known.Id, ModelAPI: string(known.Api), ModelURL: known.BaseUrl, ContextWindow: int(known.ContextWindow), MaxTokens: int(known.MaxTokens), Thinking: level}
	if _, err := model.Generate(context.Background(), c, filepath.Join(dir, "session.jsonl"), dir, "First", "synthetic-test-key"); err != nil {
		t.Fatal(err)
	}
	// A saved conversation must also accept a changed thinking level on its next turn.
	level = "low"
	c.Thinking = level
	if _, err := model.Generate(context.Background(), c, filepath.Join(dir, "session.jsonl"), dir, "Continue", "synthetic-test-key"); err != nil {
		t.Fatal(err)
	}
	if calls != 2 {
		t.Fatal("conversation did not continue")
	}
}
