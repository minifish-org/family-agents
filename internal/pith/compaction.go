package pith

import (
	"context"
	"errors"

	agenttypes "github.com/minifish-org/pith/packages/agent/types"
	"github.com/minifish-org/pith/packages/ai/api"
	aitypes "github.com/minifish-org/pith/packages/ai/types"
	codingagent "github.com/minifish-org/pith/packages/coding-agent"
)

// summaryStream reuses the same Pith API modules as the embedded session.
// It binds this agent's saved key explicitly; no ambient credentials are read.
func (m Model) summaryStream(ctx context.Context, key string) agenttypes.StreamFn {
	return func(model *aitypes.Model, transcript *aitypes.TranscriptContext, options *aitypes.SimpleStreamOptions) *aitypes.AssistantMessageEventStream {
		opts := *options
		opts.APIKey = &key
		retries := 0
		opts.MaxRetries = &retries
		stream := m.Stream
		if stream == nil {
			switch model.Api {
			case aitypes.ApiOpenAICompletions:
				stream = api.OpenAICompletionsStreamSimple
			case aitypes.ApiOpenAIResponses:
				stream = api.OpenAIResponsesStreamSimple
			case aitypes.ApiOpenAICodexResponses:
				stream = api.OpenAICodexResponsesStreamSimple
			case aitypes.ApiAzureOpenAIResponses:
				stream = api.AzureOpenAIResponsesStreamSimple
			case aitypes.ApiAnthropicMessages:
				stream = api.AnthropicMessagesStreamSimple
			case aitypes.ApiGoogleGenerativeAI:
				stream = api.GoogleGenerativeAIStreamSimple
			case aitypes.ApiGoogleVertex:
				stream = api.GoogleVertexStreamSimple
			case aitypes.ApiMistralConversations:
				stream = api.MistralConversationsStreamSimple
			case aitypes.ApiBedrockConverseStream:
				stream = api.BedrockConverseStreamSimple
			case aitypes.ApiPiMessages:
				stream = api.PiMessagesStreamSimple
			}
		}
		if stream == nil {
			return nil
		}
		source := stream(model, transcript, &opts)
		if source == nil {
			return nil
		}
		response, err := source.Result(ctx)
		// The SDK rejects empty/error/length summaries. Also reject aborted and
		// tool-use outcomes: a partial checkpoint must never replace active context.
		if err != nil || ctx.Err() != nil || response.StopReason != aitypes.StopReasonStop {
			response = aitypes.NewAssistantMessage(model.Api, model.Provider, model.Id, 0)
			response.StopReason = aitypes.StopReasonError
			message := "Compaction request did not finish; original history retained"
			response.ErrorMessage = &message
		}
		result := aitypes.NewAssistantMessageEventStream()
		if response.StopReason == aitypes.StopReasonStop {
			result.Push(aitypes.NewDoneEvent(response.StopReason, response))
		} else {
			result.Push(aitypes.NewErrorEvent(aitypes.StopReasonError, response))
		}
		return result
	}
}

func (m Model) compactionPolicy(model *aitypes.Model, key, system, input string) codingagent.RunPolicy {
	// The SDK estimates stored messages. Reserve room for the current prompt and
	// system instructions too, without changing the model's declared capacities.
	systemTokens := codingagent.EstimateTokens(agenttypes.NewAgentMessageFromMessage(aitypes.NewUserMessageVariant(aitypes.NewUserMessage(system, 0))))
	inputTokens := codingagent.EstimateTokens(agenttypes.NewAgentMessageFromMessage(aitypes.NewUserMessageVariant(aitypes.NewUserMessage(input, 0))))
	reserve := int(model.MaxTokens) + systemTokens + inputTokens + 256
	return codingagent.RunPolicy{MaxTurns: 2, RetryAttempts: 0, CompactReserveTokens: reserve,
		Summarize: func(ctx context.Context, messages []agenttypes.AgentMessage) (string, error) {
			summary, err := codingagent.GenerateSummary(ctx, messages, model, codingagent.DefaultCompactionPolicy.ReserveTokens, m.summaryStream(ctx, key), nil, nil)
			if err != nil {
				if ctx.Err() != nil {
					return "", ctx.Err()
				}
				return "", errors.New("conversation compaction failed; original history retained")
			}
			return summary, nil
		},
	}
}
