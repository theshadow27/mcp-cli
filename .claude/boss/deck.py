import json, subprocess, time
rows = json.loads(subprocess.run(["mcx","claude","ls","--json"],capture_output=True,text=True).stdout or "[]")
now = time.time()*1000
print("name   id        state       alive rl     age turns    tok  cwd")
for s in rows:
    if not (s.get("processAlive") or s.get("state") in ("active","idle")):
        continue
    print("%-6s %-9s %-11s %-5s %-5s %4dm %5d %6d  %s" % (
        s["name"], s["sessionId"][:8], s["state"], s["processAlive"], s["rateLimited"],
        int((now-s["createdAt"])/60000), s["numTurns"], s["tokens"],
        (s.get("cwd") or "-").split("/")[-1]))
dead = [s["name"] for s in rows if not s.get("processAlive") and s.get("state") not in ("ended",)]
print("\nnot-alive:", ", ".join(dead) if dead else "none")
