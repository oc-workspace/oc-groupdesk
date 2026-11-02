ARG BASE_IMAGE=wechat-bot:transient-cleanup-d3f7e150c8b0
FROM ${BASE_IMAGE}
ARG SOURCE_REVISION
COPY src/bowxt/client.py src/bowxt/service.py src/bowxt/store.py src/bowxt/transient_recovery.py src/bowxt/identity_recovery.py /opt/bowxt/src/bowxt/
LABEL org.rococo.groupdesk.revision=${SOURCE_REVISION}
