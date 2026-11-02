import time
import unittest
from bowxt.service import BowxtService, SyncMode
import test_service as fixtures
from bowxt.models import ChatType

class SendOnlyTests(unittest.TestCase):
    setUp=fixtures.BowxtServiceTests.setUp
    tearDown=fixtures.BowxtServiceTests.tearDown
    def test_send_only_never_polls_or_discovers_chats(self):
        self.client.unread=['Do not open this chat']
        service=BowxtService(self.store,client_factory=lambda:self.client,poll_gap=1.5)
        service.add_chat('Synthetic group',ChatType.GROUP)
        service.configure(mode=SyncMode.SEND_ONLY)
        service.start()
        try:
            deadline=time.monotonic()+3
            while not self.client.connected and time.monotonic()<deadline:time.sleep(.01)
            self.assertTrue(self.client.connected)
            time.sleep(.1)
            self.assertEqual(self.client.calls,[])
            self.assertEqual(self.client.unread,['Do not open this chat'])
        finally:service.stop()

    def test_send_only_preserves_the_guarded_outgoing_queue(self):
        service=BowxtService(self.store,client_factory=lambda:self.client,poll_gap=1.5)
        chat=service.add_chat('Synthetic group',ChatType.GROUP)
        service.configure(mode=SyncMode.SEND_ONLY)
        service.start()
        try:
            service.enqueue_text(chat.id,'Synthetic text',client_id='synthetic-reader-send')
            self.assertTrue(self.client.send_started.wait(3))
            self.assertEqual(self.client.sent,[('Synthetic group','Synthetic text',ChatType.GROUP)])
            self.assertEqual(self.client.calls,[])
            service.configure(paused=True);service.configure(paused=False)
            self.assertEqual(service.status()['mode'],'send_only')
        finally:service.stop()
