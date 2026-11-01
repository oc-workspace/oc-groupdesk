ARG BASE_IMAGE=wechat-bot:4.1.13.23-bowxt0.4.0-responsiveness-20261030
FROM ${BASE_IMAGE}
ARG SOURCE_REVISION
COPY src/bowxt/client.py src/bowxt/service.py src/bowxt/store.py src/bowxt/frame_identity.py /opt/bowxt/src/bowxt/
LABEL org.rococo.groupdesk.revision=${SOURCE_REVISION}
