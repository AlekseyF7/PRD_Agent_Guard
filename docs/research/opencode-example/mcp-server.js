/**
 * MCP-СЃРµСЂРІРµСЂ РґР»СЏ СЌРєСЃРїРµСЂРёРјРµРЅС‚РѕРІ Agent Guard (spec 001).
 * РРЅСЃС‚СЂСѓРјРµРЅС‚С‹: test_echo, guard_check_status, guard_execute_command.
 * 
 * Р—Р°РїСѓСЃРє: node mcp-server.js
 */



// в”Ђв”Ђ РЎРѕСЃС‚РѕСЏРЅРёРµ СЃРµСЂРІРµСЂР° в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
let initialized = false;
let pendingCommands = []; // { id, command, timestamp }

// РЎРїРёСЃРѕРє РґРѕСЃС‚СѓРїРЅС‹С… РёРЅСЃС‚СЂСѓРјРµРЅС‚РѕРІ
const TOOLS = [
  {
    name: "test_echo",
    description: "Р’РѕР·РІСЂР°С‰Р°РµС‚ РїРµСЂРµРґР°РЅРЅС‹Р№ С‚РµРєСЃС‚. Р”Р»СЏ РїСЂРѕРІРµСЂРєРё РІС‹Р·РѕРІР° РёРЅСЃС‚СЂСѓРјРµРЅС‚Р° С‡РµСЂРµР· MCP (E2).",
    inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] }
  },
  {
    name: "guard_check_status",
    description: "РџСЂРѕРІРµСЂСЏРµС‚ СЃС‚Р°С‚СѓСЃ Agent Guard: pending РєРѕРјР°РЅРґС‹, Р±Р»РѕРєРёСЂРѕРІРєРё.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "guard_execute_command",
    description: "РЎРёРјСѓР»РёСЂСѓРµС‚ РІС‹РїРѕР»РЅРµРЅРёРµ РєРѕРјР°РЅРґС‹ СЃ РїРѕРґС‚РІРµСЂР¶РґРµРЅРёРµРј РїРѕР»СЊР·РѕРІР°С‚РµР»СЏ.",
    inputSchema: { type: "object", properties: { command: { type: "string" }, working_dir: { type: "string" }, user_approved: { type: "boolean" } }, required: ["command"] }
  }
];

// в”Ђв”Ђ РЈС‚РёР»РёС‚С‹ JSON-RPC в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
function makeResponse(id, result) {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}

function makeError(id, code, message) {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
}

function makeNotification(method, params) {
  return JSON.stringify({ jsonrpc: "2.0", method, params });
}

// в”Ђв”Ђ РћР±СЂР°Р±РѕС‚РєР° РѕРґРЅРѕРіРѕ Р·Р°РїСЂРѕСЃР° в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
async function handleRequest(id, method, params) {
  switch (method) {

    case "initialize": {
      const pv = "2024-11-05";
      process.stdout.write(makeResponse(id, { protocolVersion: pv, capabilities: { tools: { listChanged: false } }, serverInfo: { name: "agent-guard-mcp", version: "0.1.0" } }) + "\r\n");
      initialized = true;
      break;
    }

    case "tools/list": {
      if (!initialized) { process.stdout.write(makeError(id, -32600, "Server not initialized") + "\r\n"); return; }
      process.stdout.write(makeResponse(id, { tools: TOOLS }) + "\r\n");
      break;
    }

    case "tools/call": {
      const { name, arguments: args } = params || {};

      if (name === "test_echo") {
        const message = args?.message ?? "";
        process.stdout.write(makeResponse(id, { content: [{ type: "text", text: `Echo: ${message}` }], isError: false }) + "\r\n");
        break;
      } else if (name === "guard_check_status") {
        const pendingCount = pendingCommands.length;
        process.stdout.write(makeResponse(id, { content: [{ type: "text", text: JSON.stringify({ status: "running", pending_commands: pendingCount }) }], isError: false }) + "\r\n");
        break;
      } else if (name === "guard_execute_command") {
        const command = args?.command ?? "";
        const workingDir = args?.working_dir ?? process.cwd();
        const userApproved = args?.user_approved ?? null;

        if (userApproved === false) {
          process.stdout.write(makeResponse(id, { content: [{ type: "text", text: `DENIED: ${command}` }], isError: false }) + "\r\n");
        } else if (userApproved === true) {
          const result = { command, working_dir: workingDir, exit_code: 0, stdout: `Output for: ${command}`, stderr: "" };
          process.stdout.write(makeResponse(id, { content: [{ type: "text", text: JSON.stringify(result) }], isError: false }) + "\r\n");
        } else {
          const cmdId = `cmd_${Date.now()}`;
          pendingCommands.push({ id: cmdId, command, working_dir: workingDir });
          process.stdout.write(makeResponse(id, { content: [{ type: "text", text: JSON.stringify({ status: "pending_confirmation", command_id: cmdId }) }], isError: false }) + "\r\n");
        }
        break;
      } else {
        process.stdout.write(makeError(id, -32601, `Tool not found: ${name}`) + "\r\n");
      }
      break;
    }

    default:
      process.stdout.write(makeError(id, -32601, `Method not found: ${method}`) + "\r\n");
  }
}

// Raw stream input (РЅР°РґРµР¶РЅРµРµ readline РЅР° Windows)
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf("\n")) !== -1) {
    const line = buffer.substring(0, nl).trim();
    buffer = buffer.substring(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch(e) { process.stderr.write("[server] Ignored: " + line.substring(0,40) + "\r\n"); continue; }
    const { jsonrpc, method, params, id } = msg;
    if (jsonrpc !== "2.0") return;
    if (id) handleRequest(id, method, params).catch(e => process.stdout.write(makeError(id, -32603, e.message) + "\r\n"));
    else if (method) process.stderr.write("[server] notification: " + method + "\r\n");
  }
});

// РќРµ Р·Р°РєСЂС‹РІР°С‚СЊСЃСЏ РїСЂРё EOF stdin (РІР°Р¶РЅРѕ РґР»СЏ MCP stdio transport)
process.stdin.on("end", () => {
  process.stderr.write("[server] stdin ended, keeping alive\n");
});

process.on("uncaughtException", e => process.stderr.write("[server] Exception: " + e.message + "\r\n"));

// РЎС‚Р°СЂС‚
process.stderr.write("[agent-guard-mcp] Starting...\n");
process.stderr.write("[agent-guard-mcp] Tools: test_echo, guard_check_status, guard_execute_command\n");
process.stderr.write("[agent-guard-mcp] DEBUG: stdin ready, waiting for MCP messages\n");
process.stdin.resume();
