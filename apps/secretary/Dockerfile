# syntax=docker/dockerfile:1
# ИИ-«Секретарь»: агент стенограммы. Контекст сборки — apps/secretary.
# BUILD_CA_FILE (секрет сборки build_ca) — корневой сертификат корпоративного прокси, если сеть подменяет TLS; в образ не попадает.
FROM python:3.13-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /app
COPY requirements.txt .
RUN --mount=type=secret,id=build_ca \
    if [ -s /run/secrets/build_ca ]; then export PIP_CERT=/run/secrets/build_ca; fi; \
    pip install -r requirements.txt
COPY secretary secretary
USER nobody
EXPOSE 8070
HEALTHCHECK --interval=10s --timeout=3s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8070/healthz')"
CMD ["python", "-m", "secretary.app"]
