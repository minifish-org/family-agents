package pith

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/minifish-org/pith-post/internal/domain"
	aitypes "github.com/minifish-org/pith/packages/ai/types"
)

func TestRealSDKPersistsConversationWithNoToolsOrResourceDiscovery(t *testing.T) {
	dir := t.TempDir()
	workspace := filepath.Join(dir, "workspace")
	if err := os.MkdirAll(workspace, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "AGENTS.md"), []byte("Do not discover this private parent file"), 0600); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "session.jsonl")
	c := domain.Config{ID: "test", Prompt: "Original system prompt", Model: "test-model", ModelURL: "https://model.example.test/v1", ModelAPI: "openai-completions", ContextWindow: 8192, MaxTokens: 1024}
	calls := 0
	m := Model{Stream: func(model *aitypes.Model, transcript *aitypes.TranscriptContext, options *aitypes.SimpleStreamOptions) *aitypes.AssistantMessageEventStream {
		calls++
		raw, _ := json.Marshal(transcript)
		text := string(raw)
		for _, message := range transcript.Messages {
			if message.System != nil && len(message.System.ToolsAdded) != 0 {
				t.Error("chat-only SDK session exposed tools")
			}
		}
		if strings.Contains(text, "private parent file") {
			t.Error("SDK discovered filesystem context")
		}
		if calls == 1 && !strings.Contains(text, "Original system prompt") {
			t.Error("initial system prompt missing")
		}
		if calls == 2 && (!strings.Contains(text, "Changed system prompt") || !strings.Contains(text, "Remember blue") || !strings.Contains(text, "First answer")) {
			t.Error("updated prompt or persisted context missing")
		}
		message := aitypes.NewAssistantMessage(model.Api, model.Provider, model.Id, 1)
		answer := "First answer"
		if calls == 2 {
			answer = "Second answer"
		}
		message.Content = []aitypes.ContentBlock{aitypes.TextBlock(answer)}
		message.StopReason = aitypes.StopReasonStop
		stream := aitypes.NewAssistantMessageEventStream()
		stream.Push(aitypes.NewDoneEvent(aitypes.StopReasonStop, message))
		return stream
	}}
	if _, err := m.Generate(context.Background(), c, path, workspace, "Remember blue", ""); err != nil {
		t.Fatalf("execution failed: %v; cause: %v", err, errors.Unwrap(err))
	}
	c.Prompt = "Changed system prompt"
	result, err := m.Generate(context.Background(), c, path, workspace, "Continue", "")
	if err != nil {
		t.Fatal(err)
	}
	if calls != 2 || len(result) != 1 || result[0].Text != "Second answer" {
		t.Fatal("SDK did not produce the expected persisted continuation")
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0600 {
		t.Fatal("session file is not private")
	}
}
func TestModelRequestedShellToolCannotExecute(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "must-not-exist")
	c := domain.Config{Prompt: "Chat only", Model: "test", ModelAPI: "openai-completions", ModelURL: "https://model.example.test", ContextWindow: 4096, MaxTokens: 256}
	m := Model{Stream: func(model *aitypes.Model, _ *aitypes.TranscriptContext, _ *aitypes.SimpleStreamOptions) *aitypes.AssistantMessageEventStream {
		args, _ := json.Marshal(map[string]string{"command": "touch " + target})
		call := aitypes.NewToolCall("forbidden-call", "bash", args)
		message := aitypes.NewAssistantMessage(model.Api, model.Provider, model.Id, 1)
		message.Content = []aitypes.ContentBlock{{Type: aitypes.ContentTypeToolCall, ToolCall: &call}}
		message.StopReason = aitypes.StopReasonToolUse
		stream := aitypes.NewAssistantMessageEventStream()
		stream.Push(aitypes.NewDoneEvent(aitypes.StopReasonToolUse, message))
		return stream
	}}
	_, _ = m.Generate(context.Background(), c, filepath.Join(dir, "session.jsonl"), dir, "Try a forbidden tool", "")
	if _, err := os.Stat(target); !os.IsNotExist(err) {
		t.Fatal("model-requested shell tool executed despite the empty allowlist")
	}
}

func TestAttachmentEnvelopeValidation(t *testing.T) {
	items, err := ParseContent(`{"pith_post":[{"kind":"file","name":"note.txt","mime":"text/plain","data":"SGVsbG8="}]}`)
	if err != nil || len(items) != 1 || string(items[0].Data) != "Hello" {
		t.Fatal("valid file envelope was rejected")
	}
	for _, bad := range []string{`{"pith_post":[]}`, `{"pith_post":[{"kind":"file","name":"../../secret","mime":"text/plain","data":"SGk="}]}`, `{"pith_post":[{"kind":"image","name":"x.svg","mime":"image/svg+xml","data":"SGk="}]}`} {
		if _, err := ParseContent(bad); err == nil {
			t.Fatal("unsafe content envelope was accepted")
		}
	}
}
