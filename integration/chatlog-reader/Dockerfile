FROM python:3.12-slim-bookworm@sha256:e697c81897302a4c4333bade000d98038fbb21eb064f8ee1fd42d02ebcd9d337 AS runtime
COPY inputs/wheels /wheels
RUN pip install --no-cache-dir --no-index --find-links=/wheels --no-deps pycryptodome==3.23.0 zstandard==0.22.0 && rm -rf /wheels
COPY inputs/upstream/chatlog_keeper /opt/chatlog-keeper/chatlog_keeper
COPY inputs/upstream/LICENSE /opt/chatlog-keeper/LICENSE
COPY chatlog_reader /app/chatlog_reader
ENV PYTHONPATH=/app:/opt/chatlog-keeper PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 TMPDIR=/work TZ=Asia/Singapore
WORKDIR /app
USER 1000:1000
ENTRYPOINT ["python","-m","chatlog_reader"]
CMD ["serve"]

FROM runtime AS test
COPY tests /tests
COPY inputs/chatlog_runtime.py /app/chatlog_runtime.py
ENTRYPOINT ["python","-W","error::ResourceWarning","-m","unittest","discover","-s","/tests","-v"]

FROM runtime AS production
