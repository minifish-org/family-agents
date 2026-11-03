package pith

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/minifish-org/pith-post/internal/domain"
	aitypes "github.com/minifish-org/pith/packages/ai/types"
	codingagent "github.com/minifish-org/pith/packages/coding-agent"
)

func compactionConfig() domain.Config {
	return domain.Config{ID: "compaction", Prompt: "Keep the owner's facts and personal style.", Model: "local-model", ModelAPI: "openai-completions", ModelURL: "http://127.0.0.1:1/v1", ContextWindow: 8192, MaxTokens: 1024}
}
func appendCompactionHistory(t *testing.T, path string, count int) (string, []byte) {
	t.Helper()
	manager, err := codingagent.OpenSession(path)
	if err != nil {
		t.Fatal(err)
	}
	id := manager.SessionID()
	for i := 0; i < count; i++ {
		user := aitypes.NewUserMessageVariant(aitypes.NewUserMessage(fmt.Sprintf("ARCHIVED_MARKER_%02d: bicycle is blue. %s", i, strings.Repeat("older context ", 180)), float64(i)))
		assistant := aitypes.NewAssistantMessage("openai-completions", "pith-post", "local-model", float64(i))
		assistant.Content = []aitypes.ContentBlock{aitypes.TextBlock(fmt.Sprintf("RECENT_REPLY_%02d: noted the blue bicycle.", i))}
		assistant.StopReason = aitypes.StopReasonStop
		for _, message := range []aitypes.Message{user, aitypes.NewAssistantMessageVariant(assistant)} {
			raw, _ := json.Marshal(message)
			if _, err = manager.AppendMessage(raw); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err = manager.Close(); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return id, raw
}
func isSummaryRequest(transcript *aitypes.TranscriptContext) bool {
	for _, message := range transcript.Messages {
		if message.System != nil && message.System.Content.Text == codingagent.SummarizationSystemPrompt {
			return true
		}
	}
	return false
}
func compactionResponse(model *aitypes.Model, text string, stop aitypes.StopReason) *aitypes.AssistantMessageEventStream {
	response := aitypes.NewAssistantMessage(model.Api, model.Provider, model.Id, 1)
	response.Content = []aitypes.ContentBlock{aitypes.TextBlock(text)}
	response.StopReason = stop
	stream := aitypes.NewAssistantMessageEventStream()
	if stop.IsErrorReason() {
		stream.Push(aitypes.NewErrorEvent(stop, response))
	} else {
		stream.Push(aitypes.NewDoneEvent(stop, response))
	}
	return stream
}
func TestAutomaticCompactionKeepsRawHistoryAndSurvivesReopen(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "conversation.jsonl")
	id, original := appendCompactionHistory(t, path, 20)
	c := compactionConfig()
	summaries, replies := 0, 0
	model := Model{Stream: func(m *aitypes.Model, transcript *aitypes.TranscriptContext, options *aitypes.SimpleStreamOptions) *aitypes.AssistantMessageEventStream {
		encoded, _ := json.Marshal(transcript)
		if options.APIKey == nil || *options.APIKey != "synthetic-compaction-key" {
			t.Error("saved key missing from request")
		}
		if m.ContextWindow != 8192 || m.MaxTokens != 1024 {
			t.Error("compaction mutated model capacities")
		}
		for _, message := range transcript.Messages {
			if message.System != nil && len(message.System.ToolsAdded) > 0 {
				t.Error("compaction enabled tools")
			}
		}
		if isSummaryRequest(transcript) {
			summaries++
			if summaries == 1 && !strings.Contains(string(encoded), "bicycle is blue") {
				t.Error("older history not given to Pith summary")
			}
			if summaries == 2 && !strings.Contains(string(encoded), "CHECKPOINT_BLUE") {
				t.Error("previous summary was not carried into repeated compaction")
			}
			return compactionResponse(m, "CHECKPOINT_BLUE: the owner's bicycle is blue.", aitypes.StopReasonStop)
		}
		replies++
		if !strings.Contains(string(encoded), "CHECKPOINT_BLUE") || !strings.Contains(string(encoded), c.Prompt) {
			t.Error("summary or persona missing after compaction")
		}
		if replies == 1 && !strings.Contains(string(encoded), "RECENT_REPLY_19") {
			t.Error("recent conversation was not retained verbatim")
		}
		if replies == 1 && strings.Contains(string(encoded), "ARCHIVED_MARKER_00") {
			t.Error("compacted raw history was still sent to the reply model")
		}
		return compactionResponse(m, fmt.Sprintf("Reply %d: your bicycle is blue.", replies), aitypes.StopReasonStop)
	}}
	for _, input := range []string{"What color is my bicycle?", "Continue after reopening this session."} {
		result, err := model.Generate(context.Background(), c, path, dir, input, "synthetic-compaction-key")
		if err != nil || len(result) != 1 || strings.HasPrefix(result[0].Text, "CHECKPOINT") {
			t.Fatal("compaction failed or summary was delivered as the reply", err)
		}
	}
	if summaries != 1 || replies != 2 {
		t.Fatalf("unexpected compaction/reply counts: %d/%d", summaries, replies)
	}
	// Grow the same conversation again, exercising a summary of the previous checkpoint.
	appendCompactionHistory(t, path, 20)
	if _, err := model.Generate(context.Background(), c, path, dir, "Remember our earlier discussion.", "synthetic-compaction-key"); err != nil {
		t.Fatal(err)
	}
	if summaries != 2 || replies != 3 {
		t.Fatal("repeated compaction did not continue the same conversation")
	}
	raw, _ := os.ReadFile(path)
	if !bytes.HasPrefix(raw, original) {
		t.Fatal("raw transcript was rewritten")
	}
	manager, err := codingagent.OpenSession(path)
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Close()
	if manager.SessionID() != id {
		t.Fatal("compaction replaced the conversation")
	}
	checkpoints, messages := 0, 0
	for _, entry := range manager.Entries() {
		if entry.Type == "compaction" {
			checkpoints++
		}
		if entry.Type == "message" {
			messages++
		}
	}
	if checkpoints != 2 || messages < 86 {
		t.Fatalf("history/checkpoints missing: %d messages, %d checkpoints", messages, checkpoints)
	}
}
func TestCompactionFailuresPreserveHistoryAndDoNotAdmitOrReply(t *testing.T) {
	for _, kind := range []string{"empty", "length", "error", "aborted", "tool-use", "cancelled"} {
		t.Run(kind, func(t *testing.T) {
			dir := t.TempDir()
			path := filepath.Join(dir, "conversation.jsonl")
			id, before := appendCompactionHistory(t, path, 20)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			calls := 0
			model := Model{Stream: func(m *aitypes.Model, transcript *aitypes.TranscriptContext, options *aitypes.SimpleStreamOptions) *aitypes.AssistantMessageEventStream {
				calls++
				if !isSummaryRequest(transcript) {
					t.Error("reply started after failed compaction")
				}
				text := "Incomplete private history"
				stop := aitypes.StopReasonStop
				switch kind {
				case "empty":
					text = ""
				case "length":
					stop = aitypes.StopReasonLength
				case "error":
					stop = aitypes.StopReasonError
				case "aborted":
					stop = aitypes.StopReasonAborted
				case "tool-use":
					stop = aitypes.StopReasonToolUse
				case "cancelled":
					cancel()
				}
				return compactionResponse(m, text, stop)
			}}
			_, err := model.Generate(ctx, compactionConfig(), path, dir, "INPUT_NOT_ADMITTED_AFTER_FAILED_COMPACTION", "synthetic-key")
			if err == nil || calls != 1 {
				t.Fatal("failed summary was accepted")
			}
			if kind == "cancelled" && !errors.Is(err, context.Canceled) {
				t.Fatal("cancellation was not propagated")
			}
			after, _ := os.ReadFile(path)
			if !bytes.HasPrefix(after, before) || bytes.Contains(after, []byte("INPUT_NOT_ADMITTED_AFTER_FAILED_COMPACTION")) {
				t.Fatal("failed compaction changed raw history or admitted the new request")
			}
			manager, err := codingagent.OpenSession(path)
			if err != nil {
				t.Fatal(err)
			}
			defer manager.Close()
			if manager.SessionID() != id {
				t.Fatal("failed compaction replaced session")
			}
			for _, entry := range manager.Entries() {
				if entry.Type == "compaction" {
					t.Fatal("failed summary committed a checkpoint")
				}
			}
		})
	}
}

func TestCompactionReservesIncomingInputAndPersona(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "session.jsonl")
	appendCompactionHistory(t, path, 3)
	c := compactionConfig()
	c.Prompt = strings.Repeat("persona ", 2200)
	summaries := 0
	model := Model{Stream: func(m *aitypes.Model, transcript *aitypes.TranscriptContext, _ *aitypes.SimpleStreamOptions) *aitypes.AssistantMessageEventStream {
		if isSummaryRequest(transcript) {
			summaries++
			return compactionResponse(m, "Brief summary", aitypes.StopReasonStop)
		}
		return compactionResponse(m, "Reply", aitypes.StopReasonStop)
	}}
	if _, err := model.Generate(context.Background(), c, path, dir, strings.Repeat("request context ", 500), "synthetic-key"); err != nil {
		t.Fatal(err)
	}
	if summaries != 1 {
		t.Fatal("incoming request and system instructions were not included in compaction reserve")
	}
}

func TestAutomaticCompactionUsesTheRealPithHTTPAdapter(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "conversation.jsonl")
	appendCompactionHistory(t, path, 20)
	requests, summaries := 0, 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		if r.Method != "POST" || r.URL.Path != "/v1/chat/completions" || r.Header.Get("Authorization") != "Bearer synthetic-http-compaction-key" {
			t.Error("summary/reply did not use the configured endpoint and key")
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
			return
		}
		rendered := fmt.Sprint(body)
		if _, present := body["tools"]; present {
			t.Error("summary/reply exposed tools")
		}
		text := "NORMAL_REPLY_ONLY"
		if strings.Contains(rendered, "<conversation>") {
			summaries++
			text = "HTTP_CHECKPOINT: bicycle is blue."
		} else if !strings.Contains(rendered, "HTTP_CHECKPOINT") {
			t.Error("HTTP reply request missed the summary")
		}
		w.Header().Set("Content-Type", "text/event-stream")
		chunk := map[string]any{"id": "response", "object": "chat.completion.chunk", "model": "local-model", "choices": []any{map[string]any{"index": 0, "delta": map[string]any{"role": "assistant", "content": text}, "finish_reason": nil}}}
		raw, _ := json.Marshal(chunk)
		fmt.Fprintf(w, "data: %s\n\n", raw)
		fmt.Fprint(w, "data: {\"id\":\"response\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
	}))
	defer server.Close()
	c := compactionConfig()
	c.ModelURL = server.URL + "/v1"
	result, err := (Model{}).Generate(context.Background(), c, path, dir, "Continue the chat", "synthetic-http-compaction-key")
	if err != nil {
		t.Fatal(err)
	}
	if requests != 2 || summaries != 1 || len(result) != 1 || result[0].Text != "NORMAL_REPLY_ONLY" {
		t.Fatal("real adapter did not summarize then reply exactly once")
	}
}
