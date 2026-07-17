#!/bin/bash
# Demo script for mnemon-mcp — produces formatted output for VHS recording
# Uses a temporary database to avoid polluting the real one

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
DEMO_DB="/tmp/mnemon-demo-$$.db"

# Colors
BOLD='\033[1m'
DIM='\033[2m'
CYAN='\033[36m'
GREEN='\033[32m'
YELLOW='\033[33m'
MAGENTA='\033[35m'
BLUE='\033[34m'
WHITE='\033[37m'
RESET='\033[0m'

cleanup() { rm -f "$DEMO_DB" "$DEMO_DB-wal" "$DEMO_DB-shm"; }
trap cleanup EXIT

# Send a JSON-RPC call to mnemon-mcp and return the parsed text result
mcp_call() {
  local method="$1"
  local params="$2"
  local init='{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"demo","version":"1.0"}},"id":0}'
  local call="{\"jsonrpc\":\"2.0\",\"method\":\"tools/call\",\"params\":{\"name\":\"$method\",\"arguments\":$params},\"id\":1}"
  printf '%s\n%s\n' "$init" "$call" | MNEMON_DB_PATH="$DEMO_DB" node "$PROJECT_DIR/dist/index.js" 2>/dev/null | tail -1
}

# Extract text field from MCP response
extract_text() {
  python3 -c "import sys,json; r=json.load(sys.stdin); print(r['result']['content'][0]['text'])"
}

# ═══════════════════════════════════════════════════
# Scene 1: memory_add — store knowledge
# ═══════════════════════════════════════════════════
scene_add() {
  echo -e "${BOLD}${CYAN}▸ memory_add${RESET}"
  echo -e "${DIM}  Storing a fact about the project...${RESET}"
  echo ""

  local raw_result
  raw_result=$(mcp_call "memory_add" '{"content":"Team migrated to TypeScript 5.9 with strict mode enabled. All new code must use unknown over any.","layer":"semantic","title":"TypeScript 5.9 migration","entity_type":"project","entity_name":"acme-app","importance":0.9,"confidence":0.95}')

  local id
  id=$(echo "$raw_result" | python3 -c "import sys,json; r=json.load(sys.stdin); t=json.loads(r['result']['content'][0]['text']); print(t['id'][:12]+'…')")

  echo -e "  ${GREEN}✓${RESET} ${BOLD}Stored${RESET}  ${DIM}id:${RESET} ${YELLOW}${id}${RESET}"
  echo -e "  ${DIM}  layer:${RESET} semantic  ${DIM}entity:${RESET} acme-app  ${DIM}importance:${RESET} 0.9"
  echo ""

  # Silently add more memories for subsequent scenes
  mcp_call "memory_add" '{"content":"Daily standup moved to 10:30 AM starting March. Previous time was 9:00 AM.","layer":"episodic","title":"Standup time change","entity_type":"project","entity_name":"acme-app","importance":0.6}' > /dev/null
  mcp_call "memory_add" '{"content":"Never deploy on Fridays after 3 PM. Last incident: db migration rolled back under load.","layer":"procedural","title":"Friday deploy freeze","entity_type":"rule","entity_name":"deployments","importance":1.0,"confidence":1.0}' > /dev/null
  mcp_call "memory_add" '{"content":"OAuth2 with PKCE required for all public clients. Server-side apps use client_credentials grant.","layer":"semantic","title":"Auth architecture","entity_type":"concept","entity_name":"auth","importance":0.85}' > /dev/null
  mcp_call "memory_add" '{"content":"Clean Architecture — dependencies point inward, domain layer has zero external imports.","layer":"resource","title":"Clean Architecture notes","entity_type":"concept","entity_name":"architecture","importance":0.7}' > /dev/null
}

# ═══════════════════════════════════════════════════
# Scene 2: memory_search — find knowledge
# ═══════════════════════════════════════════════════
scene_search() {
  echo -e "${BOLD}${CYAN}▸ memory_search${RESET} ${DIM}\"TypeScript strict\"${RESET}"
  echo ""

  local raw_result
  raw_result=$(mcp_call "memory_search" '{"query":"TypeScript strict mode","limit":3}')

  echo "$raw_result" | python3 -c "
import sys, json
r = json.load(sys.stdin)
text = json.loads(r['result']['content'][0]['text'])
results = text.get('memories', [])
colors = {'semantic': '\033[36m', 'episodic': '\033[33m', 'procedural': '\033[35m', 'resource': '\033[34m'}
for i, m in enumerate(results):
    layer = m.get('layer', '?')
    color = colors.get(layer, '\033[37m')
    title = m.get('title', '') or m.get('content', '')[:50]
    score = m.get('score', 0)
    conf = m.get('confidence', 0)
    print(f'  \033[1m{i+1}.\033[0m {title}')
    ent = m.get('entity_name') or '—'
    print(f'     {color}{layer}\033[0m · {ent} · confidence {conf:.2f} · score {score:.2f}')
    print()
qtime = text.get('query_time_ms', 0)
total = text.get('returned_count', len(results))
print(f'  \033[2mFound {total} result(s) in {qtime}ms via FTS5 + BM25\033[0m')
print()
"
}

# ═══════════════════════════════════════════════════
# Scene 3: memory_inspect — layer stats
# ═══════════════════════════════════════════════════
scene_stats() {
  echo -e "${BOLD}${CYAN}▸ memory_inspect${RESET} ${DIM}— layer statistics${RESET}"
  echo ""

  local raw_result
  raw_result=$(mcp_call "memory_inspect" '{}')

  echo "$raw_result" | python3 -c "
import sys, json
r = json.load(sys.stdin)
text = json.loads(r['result']['content'][0]['text'])
stats = text.get('layer_stats', {})
colors = {'episodic': '\033[33m', 'semantic': '\033[36m', 'procedural': '\033[35m', 'resource': '\033[34m'}
order = ['episodic', 'semantic', 'procedural', 'resource']
total = 0
for name in order:
    s = stats.get(name, {})
    count = s.get('active', 0)
    total += count
    color = colors.get(name, '\033[37m')
    bar = '█' * count + '░' * max(0, 5 - count)
    print(f'  {color}{name:12s}\033[0m {bar}  \033[1m{count}\033[0m memories')
print(f'  \033[2m{\"─\" * 38}\033[0m')
print(f'  {\"\":12s}       \033[1m{total}\033[0m total  \033[2mdb: ~/.mnemon-mcp/memory.db\033[0m')
print()
"
}

# ═══════════════════════════════════════════════════
# Scene 4: fact versioning via supersede
# ═══════════════════════════════════════════════════
scene_versioning() {
  echo -e "${BOLD}${CYAN}▸ memory_update${RESET} ${DIM}— fact versioning${RESET}"
  echo ""

  # Find the TypeScript memory
  local search_result
  search_result=$(mcp_call "memory_search" '{"query":"TypeScript migration","limit":1}')
  local old_id
  old_id=$(echo "$search_result" | python3 -c "import sys,json; r=json.load(sys.stdin); t=json.loads(r['result']['content'][0]['text']); print(t['memories'][0]['id'])")

  # Supersede it
  local update_result
  update_result=$(mcp_call "memory_update" "{\"id\":\"$old_id\",\"supersede\":true,\"new_content\":\"Team runs TypeScript 5.9 strict. Migrated to Zod 4 for runtime validation — replaces io-ts.\"}")
  local new_id
  new_id=$(echo "$update_result" | python3 -c "import sys,json; r=json.load(sys.stdin); t=json.loads(r['result']['content'][0]['text']); print(t.get('new_id', t.get('id','?'))[:12]+'…')")

  echo -e "  ${DIM}v1:${RESET} Team migrated to TypeScript 5.9 with strict mode"
  echo -e "      ${DIM}→ superseded${RESET}"
  echo -e "  ${GREEN}v2:${RESET} ${BOLD}Team runs TS 5.9 strict. Migrated to Zod 4${RESET}"
  echo -e "      ${GREEN}← active${RESET}  ${DIM}id:${RESET} ${YELLOW}${new_id}${RESET}"
  echo ""
  echo -e "  ${DIM}Search always returns latest version.${RESET}"
  echo -e "  ${DIM}Full history chain via memory_inspect --include-history.${RESET}"
  echo ""
}

# ═══════════════════════════════════════════════════
# Run
# ═══════════════════════════════════════════════════
echo ""
echo -e "${BOLD}${WHITE}  mnemon-mcp${RESET} ${DIM}— persistent layered memory for AI agents${RESET}"
echo -e "${DIM}─────────────────────────────────────────────────${RESET}"
echo ""
scene_add
sleep 1.5
scene_search
sleep 1.5
scene_stats
sleep 1.5
scene_versioning
