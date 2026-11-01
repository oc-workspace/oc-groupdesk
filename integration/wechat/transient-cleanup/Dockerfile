ARG BASE_IMAGE=wechat-bot:frame-identities-c5ae63366743
FROM ${BASE_IMAGE}
ARG SOURCE_REVISION
COPY src/bowxt/client.py src/bowxt/service.py src/bowxt/store.py src/bowxt/transient_recovery.py /opt/bowxt/src/bowxt/
LABEL org.rococo.groupdesk.revision=${SOURCE_REVISION}
