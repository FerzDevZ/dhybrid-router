#!/usr/bin/env python3
"""AutoProxy Harvester & Validator for 9Router (OpenCode Rate-Limit Shield).

Scrapes free public proxies (HTTP, HTTPS, SOCKS4, SOCKS5), validates them with
high concurrency against opencode.ai or generic HTTPS targets, benchmarks latency,
and automatically imports working proxies into 9Router Proxy Pools with Round-Robin
rotation for OpenCode Free.
"""
import argparse
import concurrent.futures
import json
import os
import re
import socket
import sqlite3
import ssl
import sys
import time
import urllib.error
import urllib.request
from collections import Counter
from http.cookiejar import CookieJar
from pathlib import Path
import uuid

try:
    import socks as pysocks
    HAS_SOCKS = True
except ImportError:
    HAS_SOCKS = False

# High-frequency updated proxy sources (SOCKS5 and HTTP/HTTPS only for TLS compatibility)
SCRAPE_SOURCES = [
    # Proxifly
    "https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/socks5/data.txt",
    "https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/http/data.txt",
    # TheSpeedX
    "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt",
    "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt",
    # monosans
    "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt",
    "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks5.txt",
    # hookzof
    "https://raw.githubusercontent.com/hookzof/socks5_list/master/proxy.txt",
    # RoosterKid
    "https://raw.githubusercontent.com/roosterkid/openproxylist/main/HTTPS_RAW.txt",
    "https://raw.githubusercontent.com/roosterkid/openproxylist/main/SOCKS5_RAW.txt",
    # MuRongPIG
    "https://raw.githubusercontent.com/MuRongPIG/Proxy-Master-List/main/socks5.txt",
    "https://raw.githubusercontent.com/MuRongPIG/Proxy-Master-List/main/http.txt",
    # sunny9577
    "https://raw.githubusercontent.com/sunny9577/proxy-scraper/master/generated/socks5_proxies.txt",
    "https://raw.githubusercontent.com/sunny9577/proxy-scraper/master/generated/http_proxies.txt",
    # officialputuid (KangProxy)
    "https://raw.githubusercontent.com/officialputuid/KangProxy/KangProxy/socks5/socks5.txt",
    "https://raw.githubusercontent.com/officialputuid/KangProxy/KangProxy/http/http.txt",
    # ErcinDedeoglu
    "https://raw.githubusercontent.com/ErcinDedeoglu/proxies/main/proxies/socks5.txt",
    "https://raw.githubusercontent.com/ErcinDedeoglu/proxies/main/proxies/http.txt",
    # vakhov
    "https://raw.githubusercontent.com/vakhov/fresh-proxy-list/master/socks5.txt",
    "https://raw.githubusercontent.com/vakhov/fresh-proxy-list/master/http.txt",
    # zevtyardt
    "https://raw.githubusercontent.com/zevtyardt/proxy-list/main/socks5.txt",
    "https://raw.githubusercontent.com/zevtyardt/proxy-list/main/http.txt",
    # Proxyscrape APIs
    "https://api.proxyscrape.com/v3/free-proxy-list/get?request=displayproxies&protocol=socks5&proxy_format=ipport&format=text",
    "https://api.proxyscrape.com/v3/free-proxy-list/get?request=displayproxies&protocol=http&proxy_format=ipport&format=text",
    # yemixzy & Zaeem20
    "https://raw.githubusercontent.com/yemixzy/proxy-list/main/proxies/socks5.txt",
    "https://raw.githubusercontent.com/Zaeem20/FREE_PROXIES_LIST/master/socks5.txt",
    "https://raw.githubusercontent.com/ALIILAPRO/Proxy/main/socks5.txt",
    "https://raw.githubusercontent.com/ALIILAPRO/Proxy/main/http.txt",
]

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
DATA_DIR = REPO_ROOT / "data" / "autoproxy"
DATA_DIR.mkdir(parents=True, exist_ok=True)
OUT_TXT = DATA_DIR / "live_proxies.txt"
OUT_JSON = DATA_DIR / "live_proxies.json"

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
VALID_SCHEMES = ("socks5://", "http://", "https://")

NINE_URL = os.environ.get("NINE_URL") or f"http://127.0.0.1:{os.environ.get('PORT') or '20127'}"
NINE_PASSWORD = os.environ.get("NINE_PASSWORD") or "jawa123"
DB_PATH = Path(os.path.expanduser("~/.9router/db/data.sqlite"))
IMPORT_CHUNK = 100
TCP_CONC = 250
PROBE_CONC = 75
TCP_TIMEOUT = 2.5
PROBE_TIMEOUT = 6.0


def scrape_from_source(url):
    """Fetch proxy list from single URL."""
    proxies = []
    try:
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=10) as resp:
            text = resp.read().decode("utf-8", errors="ignore")
        
        # Determine default scheme from url if present
        default_scheme = "http://"
        if "socks5" in url.lower():
            default_scheme = "socks5://"
        elif "socks4" in url.lower():
            default_scheme = "socks4://"

        for line in text.splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if line.startswith(VALID_SCHEMES):
                proxies.append(line)
            elif re.match(r"^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d{2,5}$", line):
                proxies.append(f"{default_scheme}{line}")
    except Exception:
        # Silently skip single source failure
        pass
    return proxies


def collect_all_proxies(limit=0):
    """Scrape from all sources and local cached files."""
    all_proxies = []
    print(f"[*] Mulai scraping dari {len(SCRAPE_SOURCES)} sumber publik fresh...", flush=True)
    
    with concurrent.futures.ThreadPoolExecutor(max_workers=16) as executor:
        results = executor.map(scrape_from_source, SCRAPE_SOURCES)
        for res in results:
            all_proxies.extend(res)

    # Also load from /home/firman/autoproxy/active_proxies.txt if exists
    local_autoproxy_file = Path("/home/firman/autoproxy/active_proxies.txt")
    if local_autoproxy_file.exists():
        try:
            for line in local_autoproxy_file.read_text(errors="ignore").splitlines():
                line = line.strip()
                if line.startswith(VALID_SCHEMES):
                    all_proxies.append(line)
                elif re.match(r"^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d{2,5}$", line):
                    all_proxies.append(f"http://{line}")
        except Exception:
            pass

    # Deduplicate
    unique = list(dict.fromkeys(all_proxies))
    print(f"[*] Total proxy terkumpul: {len(unique)} unik", flush=True)
    if limit > 0 and len(unique) > limit:
        unique = unique[:limit]
        print(f"[*] Dibatasi ke {limit} proxy pertama untuk validasi cepat.", flush=True)
    return unique


def is_known_banned_datacenter(host):
    """Filter out AWS ranges known to be 429 blocked by OpenCode."""
    parts = host.split(".")
    if len(parts) == 4 and all(p.isdigit() for p in parts):
        first = int(parts[0])
        if first in (3, 13, 18, 34, 35, 44, 52, 54):
            return True
    return False


def tcp_alive(url):
    """Fast TCP connect prefilter."""
    try:
        scheme, remainder = url.split("://", 1)
        host, port = remainder.rsplit(":", 1)
        if is_known_banned_datacenter(host):
            return False
        s = socket.create_connection((host, int(port)), timeout=TCP_TIMEOUT)
        s.close()
        return True
    except Exception:
        return False


def probe_opencode(url):
    """Probe proxy specifically for opencode.ai chat completions endpoint."""
    scheme, remainder = url.split("://", 1)
    host, port = remainder.rsplit(":", 1)
    port = int(port)
    t0 = time.time()
    
    probe_body = b'{"model":"big-pickle","messages":[{"role":"user","content":"1"}],"max_tokens":1}'
    
    try:
        if scheme in ("socks4", "socks5"):
            if not HAS_SOCKS:
                return None
            s = pysocks.socksocket()
            s.set_proxy(pysocks.SOCKS4 if scheme == "socks4" else pysocks.SOCKS5, host, port)
            s.settimeout(PROBE_TIMEOUT)
            s.connect(("opencode.ai", 443))
            
            ctx = ssl.create_default_context()
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
            tls = ctx.wrap_socket(s, server_hostname="opencode.ai")
            
            session_id = str(uuid.uuid4())
            payload = (
                b"POST /zen/v1/chat/completions HTTP/1.1\r\n"
                b"Host: opencode.ai\r\n"
                b"User-Agent: " + UA.encode() + b"\r\n"
                b"Content-Type: application/json\r\n"
                b"Content-Length: " + str(len(probe_body)).encode() + b"\r\n"
                b"x-opencode-client: desktop\r\n"
                b"x-opencode-session: " + session_id.encode() + b"\r\n"
                b"x-opencode-project: " + session_id.encode() + b"\r\n"
                b"Authorization: Bearer public\r\n"
                b"Connection: close\r\n\r\n"
            ) + probe_body
            tls.sendall(payload)
            head = tls.recv(1024)
            tls.close()
            latency = int((time.time() - t0) * 1000)
            if (head.startswith(b"HTTP/1.1 200") or b"200 OK" in head[:50]) and b"429" not in head[:50]:
                return (url, latency)
            return None
        else:
            # HTTP/HTTPS Proxy
            proxy_handler = urllib.request.ProxyHandler({
                "http": url,
                "https": url,
            })
            ctx = ssl.create_default_context()
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
            https_handler = urllib.request.HTTPSHandler(context=ctx)
            
            opener = urllib.request.build_opener(proxy_handler, https_handler)
            session_id = str(uuid.uuid4())
            req = urllib.request.Request(
                "https://opencode.ai/zen/v1/chat/completions",
                data=probe_body,
                headers={
                    "Content-Type": "application/json",
                    "User-Agent": UA,
                    "x-opencode-client": "desktop",
                    "x-opencode-session": session_id,
                    "x-opencode-project": session_id,
                    "Authorization": "Bearer public",
                },
                method="POST"
            )
            with opener.open(req, timeout=PROBE_TIMEOUT) as resp:
                if resp.status == 200:
                    latency = int((time.time() - t0) * 1000)
                    return (url, latency)
    except Exception:
        pass
    return None


def probe_general(url):
    """Probe proxy against general HTTPS endpoint."""
    scheme, remainder = url.split("://", 1)
    host, port = remainder.rsplit(":", 1)
    port = int(port)
    t0 = time.time()
    
    try:
        if scheme in ("socks4", "socks5"):
            if not HAS_SOCKS:
                return None
            s = pysocks.socksocket()
            s.set_proxy(pysocks.SOCKS4 if scheme == "socks4" else pysocks.SOCKS5, host, port)
            s.settimeout(PROBE_TIMEOUT)
            s.connect(("cloudflare.com", 443))
            
            ctx = ssl.create_default_context()
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
            tls = ctx.wrap_socket(s, server_hostname="cloudflare.com")
            
            payload = (
                b"GET /cdn-cgi/trace HTTP/1.1\r\n"
                b"Host: cloudflare.com\r\n"
                b"User-Agent: " + UA.encode() + b"\r\n"
                b"Connection: close\r\n\r\n"
            )
            tls.sendall(payload)
            head = tls.recv(512)
            tls.close()
            latency = int((time.time() - t0) * 1000)
            if head.startswith(b"HTTP/1.1 200") or b"ip=" in head:
                return (url, latency)
            return None
        else:
            proxy_handler = urllib.request.ProxyHandler({"http": url, "https": url})
            ctx = ssl.create_default_context()
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
            https_handler = urllib.request.HTTPSHandler(context=ctx)
            
            opener = urllib.request.build_opener(proxy_handler, https_handler)
            req = urllib.request.Request("https://cloudflare.com/cdn-cgi/trace", headers={"User-Agent": UA})
            with opener.open(req, timeout=PROBE_TIMEOUT) as resp:
                if resp.status == 200:
                    latency = int((time.time() - t0) * 1000)
                    return (url, latency)
    except Exception:
        pass
    return None


def build_proxy_pools(live_results):
    """Convert (url, latency) tuples into 9Router Proxy Pool objects."""
    pools = []
    for i, (url, latency) in enumerate(live_results, 1):
        scheme = url.split("://")[0]
        hostport = url.split("://")[1]
        name = f"AutoProxy-{scheme.upper()}-{hostport}"
        pools.append({
            "name": name,
            "proxyUrl": url,
            "type": "custom",
            "isActive": True,
            "latency": latency,
            "tags": ["autoproxy", "opencode-shield"],
        })
    return pools


def import_directly_to_sqlite(pools, auto_bind_opencode=False):
    """Directly insert/update proxy pools into SQLite db (fallback / high-reliability)."""
    if not DB_PATH.exists():
        print(f"[-] SQLite DB tidak ditemukan di {DB_PATH}", flush=True)
        return None
    
    now = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())
    created = 0
    updated = 0
    try:
        conn = sqlite3.connect(str(DB_PATH))
        cursor = conn.cursor()
        
        for p in pools:
            proxy_url = p.get("proxyUrl")
            name = p.get("name")
            latency = p.get("latency")
            
            # Check existing by proxyUrl in data json
            cursor.execute("SELECT id, data FROM proxyPools WHERE data LIKE ?", (f'%"{proxy_url}"%',))
            existing = cursor.fetchone()
            
            extra_data = {
                "name": name,
                "proxyUrl": proxy_url,
                "noProxy": "",
                "type": "custom",
                "strictProxy": True,
                "maxFailover": 5,
                "allowFallbackDirect": False,
                "priority": 50,
                "maxConcurrency": 0,
                "weight": 0,
                "tags": "autoproxy,opencode-shield",
                "autoUnbind": True,
                "lastTestedAt": now,
                "lastError": None,
                "requestCount": 0,
                "successCount": 0,
                "failCount": 0,
                "avgLatencyMs": latency,
                "lastLatencyMs": latency,
                "consecutiveFailures": 0,
                "cooldownUntil": None,
            }
            
            if existing:
                pool_id = existing[0]
                cursor.execute(
                    """UPDATE proxyPools SET isActive=1, testStatus='active', data=?, updatedAt=? WHERE id=?""",
                    (json.dumps(extra_data), now, pool_id)
                )
                updated += 1
            else:
                pool_id = str(uuid.uuid4())
                cursor.execute(
                    """INSERT INTO proxyPools(id, isActive, testStatus, autoDelete, geolocation, data, createdAt, updatedAt)
                       VALUES(?, 1, 'active', 0, NULL, ?, ?, ?)""",
                    (pool_id, json.dumps(extra_data), now, now)
                )
                created += 1
                
        # Auto-bind opencode in settings
        if auto_bind_opencode:
            cursor.execute("SELECT data FROM settings WHERE id = 1 OR id = 'global'")
            row = cursor.fetchone()
            if row:
                settings_data = json.loads(row[0] or "{}")
                p_strat = settings_data.get("providerStrategies") or {}
                oc_strat = p_strat.get("opencode") or {}
                oc_strat["rotateStrategy"] = "weighted"
                oc_strat["fallbackStrategy"] = "smart"
                oc_strat["allowFallbackDirect"] = False
                p_strat["opencode"] = oc_strat
                settings_data["providerStrategies"] = p_strat
                cursor.execute("UPDATE settings SET data = ?, updatedAt = ? WHERE id = 1 OR id = 'global'", (json.dumps(settings_data), now))
                print("[+] [Direct-DB] Rotasi Weighted + Smart Fallback untuk OpenCode diaktifkan di settings!", flush=True)

        conn.commit()
        conn.close()
        print(f"[+] [Direct-DB] Berhasil mengimpor {created} baru, {updated} diperbarui ke SQLite.", flush=True)
        return {"created": created, "skipped": updated, "failed": 0}
    except Exception as e:
        print(f"[-] [Direct-DB] Gagal import ke SQLite: {e}", flush=True)
        return None


def import_to_9router(pools, auto_bind_opencode=False):
    """Import pools into 9Router via REST API with fallback to Direct SQLite."""
    cj = CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))

    print(f"[*] Mencoba login ke 9Router API ({NINE_URL})...", flush=True)
    logged_in = False
    try:
        login_req = urllib.request.Request(
            f"{NINE_URL}/api/auth/login",
            data=json.dumps({"password": NINE_PASSWORD}).encode(),
            headers={"Content-Type": "application/json"},
        )
        with opener.open(login_req, timeout=10) as r:
            body = json.loads(r.read().decode())
        if body.get("success"):
            logged_in = True
            print("[+] Login berhasil ke 9Router REST API.", flush=True)
    except Exception as e:
        print(f"[-] Login API gagal ({e}), beralih ke Direct SQLite DB import...", flush=True)

    if not logged_in:
        return import_directly_to_sqlite(pools, auto_bind_opencode=auto_bind_opencode)

    # Bulk Import Pools via API
    total = {"created": 0, "skipped": 0, "failed": 0}
    for i in range(0, len(pools), IMPORT_CHUNK):
        chunk = pools[i:i + IMPORT_CHUNK]
        try:
            req = urllib.request.Request(
                f"{NINE_URL}/api/proxy-pools/import",
                data=json.dumps({"pools": chunk}).encode(),
                headers={"Content-Type": "application/json"},
            )
            with opener.open(req, timeout=60) as r:
                res = json.loads(r.read().decode())
            total["created"] += res.get("created", 0)
            total["skipped"] += res.get("skipped", 0)
            total["failed"] += res.get("failed", 0)
        except Exception as e:
            total["failed"] += len(chunk)
            print(f"[-] Import chunk {i // IMPORT_CHUNK} gagal: {e}", flush=True)

    print(f"[+] Selesai Import ke Proxy Pools: {total['created']} baru dibuat, {total['skipped']} sudah ada, {total['failed']} gagal.", flush=True)

    # Auto Bind OpenCode if requested
    if auto_bind_opencode:
        try:
            print("[*] Mengatur rotasi Round-Robin untuk provider OpenCode Free...", flush=True)
            settings_req = urllib.request.Request(f"{NINE_URL}/api/settings")
            with opener.open(settings_req, timeout=15) as r:
                current_settings = json.loads(r.read().decode())
            
            provider_strategies = current_settings.get("providerStrategies") or {}
            oc_strategy = provider_strategies.get("opencode") or {}
            oc_strategy["rotateStrategy"] = "round-robin"
            provider_strategies["opencode"] = oc_strategy

            patch_req = urllib.request.Request(
                f"{NINE_URL}/api/settings",
                data=json.dumps({"providerStrategies": provider_strategies}).encode(),
                headers={"Content-Type": "application/json"},
                method="PATCH",
            )
            with opener.open(patch_req, timeout=15) as r:
                patch_res = json.loads(r.read().decode())
            print("[+] Berhasil mengaktifkan strategi Round-Robin pada OpenCode Free!", flush=True)
        except Exception as e:
            print(f"[-] Gagal update strategi OpenCode: {e}", flush=True)

    return total


def main():
    ap = argparse.ArgumentParser(description="AutoProxy Harvester & Validator for 9Router")
    ap.add_argument("--target", choices=["opencode", "general"], default="opencode",
                    help="target probe (default: opencode)")
    ap.add_argument("--limit", type=int, default=1500,
                    help="limit proxy yang di-scrape/validasi (0 = semua)")
    ap.add_argument("--import", dest="do_import", action="store_true",
                    help="otomatis import hasil ke Proxy Pools 9Router")
    ap.add_argument("--auto-bind-opencode", action="store_true",
                    help="otomatis aktifkan rotasi Round-Robin di provider OpenCode")
    ap.add_argument("--direct-db", action="store_true",
                    help="tulis langsung ke SQLite DB tanpa melalui REST API")
    ap.add_argument("--password", default=None,
                    help="password login 9Router (default: env NINE_PASSWORD atau jawa123)")
    args = ap.parse_args()

    global NINE_PASSWORD
    if args.password:
        NINE_PASSWORD = args.password

    t0 = time.time()
    proxies = collect_all_proxies(limit=args.limit)
    if not proxies:
        print("[-] Tidak ada proxy yang ditemukan.", file=sys.stderr)
        sys.exit(1)

    print(f"\n[Tahap 1] Melakukan TCP Ping Filter pada {len(proxies)} proxy...", flush=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=TCP_CONC) as ex:
        alive_map = list(ex.map(tcp_alive, proxies))
    alive = [p for p, ok in zip(proxies, alive_map) if ok]
    print(f"[+] TCP Hidup: {len(alive)}/{len(proxies)} proxy ({int(time.time() - t0)}s)", flush=True)

    if not alive:
        print("[-] Tidak ada proxy yang lolos TCP check.", file=sys.stderr)
        sys.exit(0)

    print(f"\n[Tahap 2] Melakukan Probe ke target: [{args.target.upper()}]...", flush=True)
    probe_fn = probe_opencode if args.target == "opencode" else probe_general

    with concurrent.futures.ThreadPoolExecutor(max_workers=PROBE_CONC) as ex:
        probe_results = list(ex.map(probe_fn, alive))

    live_results = [res for res in probe_results if res is not None]
    live_results.sort(key=lambda x: x[1])  # Sort by latency ascending

    print(f"[+] Lolos Probe Validasi {args.target.upper()}: {len(live_results)} proxy live ({int(time.time() - t0)}s)", flush=True)

    if live_results:
        breakdown = Counter(url.split("://")[0] for url, _ in live_results)
        print(f"    Breakdown protokol: {dict(breakdown)}", flush=True)
        print("    Top 5 tercepat:", flush=True)
        for url, lat in live_results[:5]:
            print(f"      - {url:<35} ({lat}ms)", flush=True)

    # Save to disk
    plain_urls = [url for url, _ in live_results]
    OUT_TXT.write_text("\n".join(plain_urls) + ("\n" if plain_urls else ""))
    pools_data = build_proxy_pools(live_results)
    OUT_JSON.write_text(json.dumps(pools_data, indent=2))
    print(f"\n[Tahap 3] Hasil live disimpan ke: {OUT_TXT} & {OUT_JSON}", flush=True)

    if args.do_import and pools_data:
        if args.direct_db:
            print(f"\n[Tahap 4] Mengimpor {len(pools_data)} proxy langsung ke SQLite DB...", flush=True)
            import_directly_to_sqlite(pools_data, auto_bind_opencode=args.auto_bind_opencode)
        else:
            print(f"\n[Tahap 4] Mengimpor {len(pools_data)} proxy ke 9Router Proxy Pools...", flush=True)
            import_to_9router(pools_data, auto_bind_opencode=args.auto_bind_opencode)

    print(f"\n[✓] Selesai dalam {int(time.time() - t0)} detik.", flush=True)


if __name__ == "__main__":
    main()

