import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // 🛡️ [Security] Block Legacy URL
    // 當請求來自舊的 vibe-coding-chat 網址時，直接拒絕服務。
    const origin = req.headers.get("origin");
    if (origin && origin.includes("vibe-coding-chat")) {
      console.warn(`Blocked access from legacy origin: ${origin}`);
      return new Response("This API endpoint has migrated. Please use the new secure URL.", {
        status: 403,
        headers: corsHeaders,
      });
    }

    // 🛡️ [Security] Authenticate User
    // 🛡️ [Security] Authenticate User
    // 驗證 Authorization Header 是否包含有效的 Supabase Token
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'No authorization header passed' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // 建立 Supabase Client 來驗證 Token
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } }
    )

    // 取得使用者資訊
    const {
      data: { user },
      error: userError,
    } = await supabaseClient.auth.getUser()

    // 如果沒有使用者或 Token 無效，拒絕存取
    if (userError || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized', details: userError }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    console.log(`User authenticated: ${user.email}`);

    // 🛡️ [Security] Whitelist Check
    // 雙重保險：只允許特定 Email 使用
    const ALLOWED_EMAILS = ["eyenote@gmail.com"];
    if (!ALLOWED_EMAILS.includes(user.email ?? "")) {
      console.warn(`Blocked unauthorized user: ${user.email}`);
      return new Response(JSON.stringify({ error: "Access denied: User not whitelisted" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");
    if (!GEMINI_API_KEY) {
      throw new Error("GEMINI_API_KEY not configured");
    }

    const { message, chatHistory, model } = await req.json();

    if (!message) {
      throw new Error("Message is required");
    }

    // Default to gemini-3-flash-preview if not specified
    const modelName = model || "gemini-3-flash-preview";

    // --- RAG FLOW START ---
    let retrievedContext = "";
    try {
      // 1. Generate Embedding for the query
      // Important: Must match the model used for indexing (text-embedding-004)
      console.log(`Generating embedding for query: ${message}`);
      const embeddingResponse = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${GEMINI_API_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "models/text-embedding-004",
            content: { parts: [{ text: message }] },
            taskType: "RETRIEVAL_QUERY"
          }),
        }
      );

      if (embeddingResponse.ok) {
        const embeddingData = await embeddingResponse.json();
        const embedding = embeddingData.embedding?.values;

        if (embedding) {
          // 2. Search Database (Service Role Key usually needed for RLS bypass, 
          // but here we use the user's client. 
          // Note: our 'match_documents' function is 'security definer' or public? 
          // The migration said "Allow public read access" to anon. 
          // So user client should work!)
          console.log("Searching knowledge base...");
          const { data: documents, error: searchError } = await supabaseClient
            .rpc("match_documents", {
              query_embedding: embedding,
              match_threshold: 0.5, // Similarity threshold
              match_count: 5        // Top 5 results
            });

          if (searchError) {
            console.error("Vector search error:", searchError);
          } else if (documents && documents.length > 0) {
            console.log(`Found ${documents.length} relevant documents.`);
            retrievedContext = documents.map((doc: any) =>
              `--- 文件來源: ${doc.metadata?.filename || 'Unknown'} ---\n${doc.content}`
            ).join("\n\n");
          } else {
            console.log("No relevant documents found.");
          }
        }
      } else {
        console.error("Embedding API failed:", await embeddingResponse.text());
      }
    } catch (err) {
      console.error("RAG process failed (continuing without context):", err);
    }
    // --- RAG FLOW END ---

    // Build conversation history for Gemini
    const contents = chatHistory?.map((msg: { role: string; content: string }) => ({
      role: msg.role === "user" ? "user" : "model",
      parts: [{ text: msg.content }],
    })) || [];

    // Add current message
    contents.push({
      role: "user",
      parts: [{ text: message }],
    });

    // Modified System Instruction with RAG Context
    const systemPromptText = `你是 Lily，一位專業的 AI 創意合夥人。
- 100% 使用繁體中文回覆
- 你的夥伴是一位專業導演，記得夏娃、妮妮與啾弟
- 主動提出優化方案或解決路徑
- 當使用新技術概念時，用導演術語或影像比喻解釋
- 保持自然溫暖的對話風格

${retrievedContext ? `\n🔍【相關知識庫資料】\n以下是從導演的資料庫中找到的相關背景資料，請參考這些內容來回答問題：\n\n${retrievedContext}\n\n(引用資料時，請自然融入回答，不用刻意說"根據資料...")` : ""}`;

    // Call Gemini API
    const geminiResponse = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          contents,
          generationConfig: {
            temperature: 0.9,
            topK: 40,
            topP: 0.95,
            maxOutputTokens: 2048,
          },
          systemInstruction: {
            parts: [{
              text: systemPromptText
            }]
          }
        }),
      }
    );

    if (!geminiResponse.ok) {
      const errorData = await geminiResponse.text();
      console.error("Gemini API error:", errorData);
      throw new Error(`Gemini API error: ${geminiResponse.status}`);
    }

    const data = await geminiResponse.json();
    const aiText = data.candidates?.[0]?.content?.parts?.[0]?.text || "抱歉，我無法生成回覆。";

    return new Response(
      JSON.stringify({ response: aiText }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    console.error("Error:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
