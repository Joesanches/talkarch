"""HTTP API агента: сервис контекста запускает и останавливает сессии стенограммы."""
from __future__ import annotations

import asyncio
import hmac
import logging
import os

from aiohttp import web

from .session import Session, SessionConfig

log = logging.getLogger("secretary")

FIELDS = ("session_id", "livekit_url", "token", "asr_url", "callback_url", "callback_token")


def create_app(token: str, default_asr_url: str | None = None) -> web.Application:
    sessions: dict[str, Session] = {}
    tasks: set[asyncio.Task] = set()

    def authorized(request: web.Request) -> bool:
        got = request.headers.get("authorization", "").removeprefix("Bearer ")
        return bool(token) and hmac.compare_digest(got, token)

    async def start(request: web.Request) -> web.Response:
        if not authorized(request):
            return web.json_response({"error": "Неверный токен"}, status=401)
        body = await request.json()
        if not body.get("asr_url") and default_asr_url:
            body["asr_url"] = default_asr_url
        missing = [f for f in FIELDS if not body.get(f)]
        if missing:
            return web.json_response({"error": f"Нет полей: {', '.join(missing)}"}, status=400)
        if body["session_id"] in sessions:
            return web.json_response({"error": "Сессия уже идёт"}, status=409)
        session = Session(SessionConfig(**{f: body[f] for f in FIELDS}))
        sessions[body["session_id"]] = session

        async def run() -> None:
            try:
                await session.run()
            finally:
                sessions.pop(body["session_id"], None)

        task = asyncio.create_task(run())
        tasks.add(task)
        task.add_done_callback(tasks.discard)
        log.info("Сессия %s запущена", body["session_id"])
        return web.json_response({"status": "started"}, status=201)

    async def stop(request: web.Request) -> web.Response:
        if not authorized(request):
            return web.json_response({"error": "Неверный токен"}, status=401)
        session = sessions.get(request.match_info["id"])
        if not session:
            return web.json_response({"error": "Нет такой сессии"}, status=404)
        session.stop()
        return web.json_response({"status": "stopping"}, status=202)

    async def health(_request: web.Request) -> web.Response:
        return web.json_response({"ok": True, "sessions": len(sessions)})

    app = web.Application()
    app.add_routes([web.post("/sessions", start), web.delete("/sessions/{id}", stop), web.get("/healthz", health)])
    return app


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    token = os.environ.get("SECRETARY_TOKEN", "")
    if len(token) < 16:
        raise SystemExit("Нужен SECRETARY_TOKEN (не короче 16 символов)")
    web.run_app(create_app(token, os.environ.get("ASR_URL")), host=os.environ.get("HOST", "0.0.0.0"), port=int(os.environ.get("PORT", "8070")))


if __name__ == "__main__":
    main()
