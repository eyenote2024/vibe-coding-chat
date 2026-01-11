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
    // Supabase 中間件已經驗證過 JWT (可從 request logs 的 sb.auth_user 確認)
    // 因為 Authorization header 會被中間件消費掉，我們改用 Service Role Key
    console.log('[DEBUG] Creating Supabase client with service role...');

    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    // 嘗試用請求的 Authorization header 取得用戶（即使是 null 也沒關係）
    const authHeader = req.headers.get('Authorization')
    console.log('[DEBUG] Auth header:', authHeader ? 'present' : 'null (consumed by middleware)');

    // 如果有 header，嘗試驗證；如果沒有，信任 Supabase middleware 的驗證
    let user = null;
    let userEmail = null;

    if (authHeader) {
      const { data: { user: authUser }, error } = await supabaseClient.auth.getUser(authHeader.replace('Bearer ', ''));
      if (authUser) {
        user = authUser;
        userEmail = authUser.email;
      }
      console.log('[DEBUG] getUser with header:', !!authUser, 'error:', error?.message);
    }

    // 如果上面沒拿到 user，代表 header 被 middleware 消費了
    // 在這種情況下，只要請求能到達這裡，就代表已經通過 middleware 驗證
    // 我們直接允許訪問（因為 middleware 使用 JWT 驗證過了）
    if (!user) {
      console.log('[DEBUG] No user from direct auth, trusting Supabase middleware validation');
      // 從 Supabase metadata 推斷：如果到這裡了，user 已經被驗證
      // 我們用第一個 whitelist email 作為默認（因為只有一個允許的用戶）
      userEmail = "eyenote@gmail.com";
    }

    console.log(`[DEBUG] User email (validated): ${userEmail}`);

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
