/**
 * Lightweight LLM Client wrapper using Node's native fetch.
 * Gated by OPENAI_API_KEY and ANTHROPIC_API_KEY.
 */

export async function callLlm(
  systemPrompt: string,
  userPrompt: string,
  responseFormatJson: boolean = false
): Promise<string> {
  const openaiKey = process.env.OPENAI_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  if (!openaiKey && !anthropicKey) {
    throw new Error('Please set OPENAI_API_KEY or ANTHROPIC_API_KEY to use this feature.');
  }

  const modelOverride = process.env.PROMPTCI_LLM_MODEL;

  if (openaiKey) {
    const model = modelOverride ?? 'gpt-4o';
    const body: Record<string, unknown> = {
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
    };
    if (responseFormatJson) {
      body.response_format = { type: 'json_object' };
    }

    const res = await globalThis.fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${openaiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`OpenAI API request failed (${res.status}): ${errText}`);
    }

    const json = await res.json() as {
      choices?: Array<{
        message?: {
          content?: string;
        };
      }>;
    };
    return json.choices?.[0]?.message?.content || '';
  } else {
    // Anthropic
    const model = modelOverride ?? 'claude-3-5-sonnet-latest';
    const body: Record<string, unknown> = {
      model,
      max_tokens: 4096,
      system: systemPrompt,
      messages: [
        { role: 'user', content: userPrompt }
      ],
    };

    const res = await globalThis.fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey!,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Anthropic API request failed (${res.status}): ${errText}`);
    }

    const json = await res.json() as {
      content?: Array<{
        type?: string;
        text?: string;
      }>;
    };
    return json.content?.[0]?.text || '';
  }
}
