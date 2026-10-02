"""Environment-driven settings. Everything secret or deployment-specific lives in `backend/.env`."""

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parents[1]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=BACKEND_DIR / ".env", extra="ignore")

    app_env: str = "development"
    cors_origins: str = "http://localhost:3000,http://127.0.0.1:3000,http://localhost:5173"

    # Supabase
    supabase_url: str
    supabase_jwt_secret: str = ""  # only for projects still signing with the legacy HS256 secret

    # Postgres (use the Supabase pooler on IPv4-only networks)
    database_url: str
    db_pool_min: int = 2
    db_pool_max: int = 10
    db_statement_cache: int = 100  # set 0 behind a transaction-mode pooler (port 6543)

    # Judge0
    judge0_url: str = "https://ce.judge0.com"
    judge0_api_key: str = ""
    judge0_api_key_header: str = "X-Auth-Token"  # RapidAPI deployments use "X-RapidAPI-Key"
    judge0_api_host: str = ""  # RapidAPI only: value for the X-RapidAPI-Host header
    judge0_concurrency: int = 8  # simultaneous judge calls issued by this process
    judge0_timeout_s: float = 40.0
    judge0_max_cpu_s: float = 15.0  # Judge0 CE default ceiling for cpu_time_limit
    judge0_memory_kb: int = 512_000

    # Anti-abuse
    run_interval_s: float = 2.0
    submit_interval_s: float = 3.0
    max_code_bytes: int = 64_000

    @property
    def cors_origin_list(self) -> list[str]:
        origins = [o.strip().rstrip("/") for o in self.cors_origins.split(",") if o.strip()]
        if "*" in origins:
            return ["*"]
        return origins

    @property
    def is_production(self) -> bool:
        return self.app_env.lower() == "production"


@lru_cache
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
