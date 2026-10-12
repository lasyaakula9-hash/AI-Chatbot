import { GoogleGenAI } from "@google/genai";
import { StreamChatResponseBody } from "@workspace/api-zod";
import { Router, type IRouter } from "express";

const router: IRouter = Router();

router.post("/gemini/chat", async (req, res): Promise<void> => {
  const parsed = StreamChatResponseBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { messages } = parsed.data;
  if (messages.at(-1)?.role !== "user") {
    res.status(400).json({ error: "The last message must be from the user." });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(503).json({ error: "AI chat is not configured." });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  try {
    const ai = new GoogleGenAI({ apiKey });
    const request = {
      model: "gemini-3.8-flash",
      contents: messages.map((message) => ({
        role: message.role === "assistant" ? "model" : "user",
        parts: [{ text: message.content }],
      })),
      config: {
        systemInstruction:
          "You are a helpful, thoughtful AI assistant. Give clear, accurate, and useful answers. Use readable markdown when it helps.",
        maxOutputTokens: 8192,
      },
    };
    let stream: Awaited<ReturnType<typeof ai.models.generateContentStream>> | undefined;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        stream = await ai.models.generateContentStream(request);
        break;
      } catch (error) {
        const status =
          error && typeof error === "object" && "status" in error
            ? error.status
            : undefined;
        if (status !== 503 || attempt === 1) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 700));
      }
    }

    if (!stream) {
      throw new Error("Gemini returned no response stream.");
    }

    for await (const chunk of stream) {
      const content = chunk.text;
      if (content) {
        res.write(`data: ${JSON.stringify({ content })}\n\n`);
      }
    }

    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
  } catch (error) {
    const providerError =
      error instanceof Error ? error.message.slice(0, 500) : "Unknown provider error";
    req.log.error({ providerError }, "Gemini chat stream failed");
    res.write(
      `data: ${JSON.stringify({ error: "The assistant could not complete that response. Please try again." })}\n\n`,
    );
  } finally {
    res.end();
  }
});

export default router;
