type JsonObject = Record<string, unknown>;
type Emit = (event: JsonObject) => void;

function isRecord(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function content(value: unknown): string {
  if (typeof value === 'string') return value;
  return value == null ? '' : JSON.stringify(value);
}

// Step states that mean "this step is still running". agy 1.3.x reports
// `ACTIVE` while a tool runs and then `DONE` or `ERROR`; the other names are
// defensive. Any other state string ends the step, so a failed, denied, or
// cancelled tool still closes its `tool_use` instead of leaving the row
// pending forever.
const IN_PROGRESS_STEP_STATES = new Set(['ACTIVE', 'PENDING', 'RUNNING', 'WAITING']);

function isTerminalStepState(state: unknown): boolean {
  return typeof state === 'string' && !IN_PROGRESS_STEP_STATES.has(state);
}

function toolErrorMessage(error: unknown): string {
  if (isRecord(error)) {
    if (typeof error.message === 'string' && error.message) return error.message;
    return content(error);
  }
  return content(error);
}

// agy's stream-json protocol uses event/init/step_update/result envelopes,
// distinct from Gemini CLI's type/message/tool_use protocol.
//
// One turn can hold several `agent_response` steps (text, then a tool, then
// more text), and the terminal `result.response` is the text of ALL of them
// joined. `streamedText` therefore accumulates across every response step of
// the turn, and the result only contributes the part that was never streamed.
export function createAntigravityEventMapper(emit: Emit) {
  const toolUses = new Set<string>();
  const toolResults = new Set<string>();
  let streamedText = '';

  return (value: unknown): boolean => {
    if (!isRecord(value)) return false;
    if (value.event === 'init') {
      const init = isRecord(value.init) ? value.init : {};
      emit({ type: 'status', label: 'initializing',
        sessionId: value.conversation_id ?? null,
        ...(typeof init.model === 'string' ? { model: init.model } : {}),
      });
      return true;
    }
    if (value.event === 'step_update' && isRecord(value.step_update)) {
      const step = value.step_update;
      if (step.step_type === 'user_input') return true;
      if (step.step_type === 'agent_response') {
        if (typeof step.text_delta === 'string' && step.text_delta) {
          streamedText += step.text_delta;
          emit({ type: 'text_delta', delta: step.text_delta });
        } else {
          emit({ type: 'status', label: 'generating' });
        }
        return true;
      }
      if (step.step_type === 'tool') {
        const info = isRecord(step.tool_info) ? step.tool_info : {};
        const name = typeof info.name === 'string' ? info.name : step.tool_name;
        if (typeof name !== 'string' || typeof step.step_index !== 'number') {
          emit({ type: 'status', label: 'tool_call' });
          return true;
        }
        const id = `${step.conversation_id ?? value.conversation_id ?? 'antigravity'}:${step.step_index}`;
        const terminal = isTerminalStepState(step.state);
        if (!toolUses.has(id)) {
          toolUses.add(id);
          emit({ type: 'tool_use', id, name, input: info.parameters ?? null });
        } else if (!terminal) {
          emit({ type: 'status', label: 'tool_call_update' });
        }
        if (terminal && !toolResults.has(id)) {
          toolResults.add(id);
          const hasError = info.error != null && info.error !== false && info.error !== '';
          const isError = step.state === 'ERROR' || hasError;
          emit({ type: 'tool_result', toolUseId: id,
            content: info.output != null
              ? content(info.output)
              : hasError ? toolErrorMessage(info.error) : '',
            isError,
          });
        }
        return true;
      }
      emit({ type: 'status', label: 'running' });
      return true;
    }
    if (value.event === 'result' && isRecord(value.result)) {
      const result = value.result;
      const isError = result.status !== 'SUCCESS';
      if (isError) {
        const error = isRecord(result.error) ? result.error.message : result.error;
        emit({ type: 'error', message: content(error) || `Antigravity ended with status ${content(result.status) || 'unknown'}` });
      } else if (typeof result.response === 'string' && result.response) {
        // Emit only what streaming has not already shown. A response that
        // does not extend the streamed text is a re-rendering of text the
        // user already has, so it is dropped rather than appended again.
        const remainder = !streamedText
          ? result.response
          : result.response.startsWith(streamedText)
            ? result.response.slice(streamedText.length)
            : '';
        if (remainder) {
          streamedText += remainder;
          emit({ type: 'text_delta', delta: remainder });
        }
      }
      if (isRecord(result.usage)) {
        const usage: JsonObject = {};
        for (const [native, normalized] of [
          ['input_tokens', 'input_tokens'], ['output_tokens', 'output_tokens'],
          ['thinking_tokens', 'thought_tokens'], ['cache_read_tokens', 'cached_read_tokens'],
        ] as const) {
          if (typeof result.usage[native] === 'number') usage[normalized] = result.usage[native];
        }
        emit({ type: 'usage', usage, isError,
          durationMs: typeof result.duration_seconds === 'number' ? result.duration_seconds * 1000 : null,
        });
      }
      return true;
    }
    return false;
  };
}
