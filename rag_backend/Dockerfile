FROM python:3.11-slim-bookworm

# Environment configuration
# - Disable Python bytecode generation
# - Force unbuffered stdout/stderr
# - Disable pip version check
# - Make apt-get non-interactive (no prompts)
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    DEBIAN_FRONTEND=noninteractive

WORKDIR /app

# Robust APT setup for stable (bookworm) on slim:
# - Remove debian.sources to avoid duplicated entries
# - Rotate through several HTTPS mirrors
# - Only accept a mirror if both `apt-get update` AND a dry-run install of build-essential succeed
RUN set -eux; \
  rm -f /etc/apt/sources.list.d/debian.sources || true; \
  suite="bookworm"; \
  mirrors='deb.debian.org ftp.de.debian.org ftp.hu.debian.org ftp.uk.debian.org mirror.init7.net'; \
  success=0; \
  for m in $mirrors; do \
    echo ">>> Trying Debian mirror: https://$m/debian (suite=$suite)"; \
    { \
      echo "deb https://$m/debian ${suite} main contrib non-free non-free-firmware"; \
      echo "deb https://$m/debian ${suite}-updates main contrib non-free non-free-firmware"; \
      echo "deb https://security.debian.org/debian-security ${suite}-security main contrib non-free non-free-firmware"; \
    } > /etc/apt/sources.list; \
    if apt-get update -o Acquire::Retries=3; then \
      # Verify packages are actually available (avoid partial index success)
      if apt-get -y --no-install-recommends --dry-run install build-essential >/dev/null 2>&1; then \
        success=1; \
        break; \
      else \
        echo "Mirror $m updated but packages not resolvable, trying next..."; \
      fi; \
    else \
      echo "Mirror $m failed to update, trying next..."; \
    fi; \
  done; \
  test "$success" = "1" || (echo "No working Debian mirror over HTTPS with resolvable packages"; exit 1); \
  # Install build tools and system dependencies (explicit CA certs on slim)
  apt-get install -y --no-install-recommends \
      build-essential libmagic1 libmagic-dev curl ca-certificates; \
  # Clean up APT caches to keep the image small
  rm -rf /var/lib/apt/lists/*

# Copy requirements first (better Docker layer caching)
COPY requirements.txt /app/requirements.txt

# Install Python dependencies:
# - Cache pip downloads between builds
# - Install PyTorch CPU wheels and project requirements
RUN --mount=type=cache,target=/root/.cache/pip \
    python -m pip install -U pip wheel setuptools && \
    pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu \
        torch==2.4.1 torchvision==0.19.1 torchaudio==2.4.1 && \
    pip install --no-cache-dir -r /app/requirements.txt

# Copy the application source
COPY . .

ENV PYTHONPATH=/app

# Expose backend API port
EXPOSE 8000

# Longer keep-alive to handle long-running evaluations
CMD ["uvicorn", "upload_docs:app", "--host", "0.0.0.0", "--port", "8000", "--timeout-keep-alive", "120"]
