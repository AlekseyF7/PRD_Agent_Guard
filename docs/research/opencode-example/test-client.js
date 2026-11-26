const { spawn } = require("child_process");
const readline = require("readline");

const nodeExe = process.env.NODE_EXE || "C:\\Program Files\\nodejs\\node.exe";
const server = spawn(nodeExe, ["mcp-server.js"], { stdio: ["pipe", "pipe", "inherit"] });
console.error("[client] MCP-сервер запущен (PID:", server.pid, ")");

const rl = readline.createInterface({ input: server.stdout });
let responses = [];

function sendRequest(method, params) {
  const msg = JSON.stringify({ jsonrpc: "2.0", id: responses.length + 1, method, params });
  console.error("[client] ->", method);
  server.stdin.write(msg + "\r\n");
}

rl.on("line", (line) => {
  try {
    const parsed = JSON.parse(line);
    responses.push(parsed);
    console.error("[client] <-", JSON.stringify(parsed, null, 2));
  } catch { console.error("[client] <- (не JSON):", line); }
});

async function runTests() {
  await new Promise(r => setTimeout(r, 1000));
  
  console.error("\n=== Тест 1: initialize ===");
  sendRequest("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test-client", version: "0.1" } });
  await new Promise(r => setTimeout(r, 500));

  console.error("\n=== Тест 2: tools/list ===");
  sendRequest("tools/list", {});
  await new Promise(r => setTimeout(r, 500));

  console.error("\n=== Тест 3: test_echo ===");
  sendRequest("tools/call", { name: "test_echo", arguments: { message: "Hello from Agent Guard research" } });
  await new Promise(r => setTimeout(r, 500));

  console.error("\n=== Тест 4: guard_check_status ===");
  sendRequest("tools/call", { name: "guard_check_status", arguments: {} });
  await new Promise(r => setTimeout(r, 500));

  console.error("\n=== Тест 5: guard_execute_command (pending) ===");
  sendRequest("tools/call", { name: "guard_execute_command", arguments: { command: "rm -rf /tmp/test" } });
  await new Promise(r => setTimeout(r, 500));

  console.error("\n=== Тест 6: guard_execute_command (approved) ===");
  sendRequest("tools/call", { name: "guard_execute_command", arguments: { command: "echo hello", user_approved: true } });
  await new Promise(r => setTimeout(r, 500));

  console.error("\n=== Тест 7: guard_execute_command (denied) ===");
  sendRequest("tools/call", { name: "guard_execute_command", arguments: { command: "rm -rf /tmp/test2", user_approved: false } });
  await new Promise(r => setTimeout(r, 1000));

  console.error("\n=== ИТОГ:", responses.length, "ответов ===");
  const ok = responses.filter(r => r.result && !r.error).length;
  const err = responses.filter(r => r.error).length;
  console.error(ok, "ok", err, "errors");

  setTimeout(() => { server.kill(); process.exit(0); }, 2000);
}
runTests().catch(e => { console.error("Error:", e); server.kill(); process.exit(1); });
