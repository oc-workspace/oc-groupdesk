"""Local TCP relay for the Groupdesk bridge's HTTPS traffic over IPv6.

TLS remains end-to-end between the bridge and Groupdesk. This listener only
binds to the Tatsumi Docker bridge gateway and cannot reach other targets.
"""
import asyncio
import socket

LISTEN = ('172.17.0.1', '172.20.0.1')
TARGET = '2a0a:4cc0:2000:2be0:d83e:47ff:fe76:2d9'
LIMIT = asyncio.Semaphore(32)


async def forward(reader, writer):
    try:
        while data := await asyncio.wait_for(reader.read(65536), 90):
            writer.write(data)
            await writer.drain()
    except (asyncio.TimeoutError, ConnectionError, OSError):
        pass


async def serve(client_reader, client_writer):
    async with LIMIT:
        try:
            target_reader, target_writer = await asyncio.wait_for(
                asyncio.open_connection(TARGET, 443, family=socket.AF_INET6), 8)
        except (asyncio.TimeoutError, ConnectionError, OSError):
            client_writer.close()
            await client_writer.wait_closed()
            return
        tasks = [asyncio.create_task(forward(client_reader, target_writer)),
                 asyncio.create_task(forward(target_reader, client_writer))]
        try:
            await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        finally:
            for task in tasks:task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            target_writer.close();client_writer.close()
            await asyncio.gather(target_writer.wait_closed(), client_writer.wait_closed(), return_exceptions=True)


async def main():
    server = await asyncio.start_server(serve, LISTEN, 443)
    async with server:await server.serve_forever()


if __name__ == '__main__':asyncio.run(main())
