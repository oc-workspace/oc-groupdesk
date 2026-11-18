import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from bowxt import WeChatClient
from bowxt.errors import ControlNotFound
from bowxt.input import X11Input
from bowxt.models import Rect


class WindowLayoutTests(unittest.TestCase):
    def test_expand_then_verify_chat_using_fresh_accessibility_tree(self):
        narrow = SimpleNamespace(bounds=Rect(0, 0, 443, 408))
        wide = SimpleNamespace(bounds=Rect(0, 0, 820, 525))
        backend = Mock()
        client = WeChatClient(accessibility=backend)
        client._root = narrow
        client._assert_clean_surface = Mock()
        client._ensure_input = Mock()
        client._ensure_input.return_value.ensure_chat_window_size.return_value = True
        client._verified_controls = Mock(return_value=object())
        backend.main_window.return_value = wide
        with patch('bowxt.client.find_search_box', return_value=object()) as search:
            client.open_chat('Authorized group')
        client._ensure_input.return_value.ensure_chat_window_size.assert_called_once_with(820, 525)
        search.assert_called_once_with(wide, client.profile)
        client._verified_controls.assert_called_once_with(wide, 'Authorized group')
        self.assertEqual(client.current_chat, 'Authorized group')

    def test_amend_only_narrow_clean_windows(self):
        client = WeChatClient(accessibility=Mock())
        root = SimpleNamespace(bounds=Rect(0, 0, 820, 525))
        with patch.object(client, '_ensure_input') as input_backend:
            self.assertIs(client._ensure_chat_layout(root), root)
            input_backend.assert_not_called()
        root.bounds = Rect(0, 0, 443, 408)
        with (patch.object(client, '_assert_clean_surface', side_effect=ControlNotFound),
              patch.object(client, '_ensure_input') as input_backend):
            with self.assertRaises(ControlNotFound):
                client._ensure_chat_layout(root)
            input_backend.assert_not_called()

    def set_up_x11(self, screen):
        backend = X11Input.__new__(X11Input)
        backend._accessible_window = Rect(0, 0, 443, 408)
        backend.x11 = Mock()
        backend.display = 404
        backend.find_wechat_window = Mock(return_value=18)
        backend.x11.XDefaultRootWindow.return_value = 1
        backend._window_geometry = Mock(side_effect=lambda window:
            Rect(1000, 300, 886, 816) if window == 18 else screen)
        return backend

    def test_resize_scales_and_keeps_the_real_window_inside_the_display(self):
        backend = self.set_up_x11(Rect(0, 0, 2552, 1420))
        self.assertTrue(backend.ensure_chat_window_size(820, 525))
        backend.x11.XMoveResizeWindow.assert_called_once_with(404, 18, 912, 300, 1640, 1050)

    def test_display_too_small_does_not_resize(self):
        backend = self.set_up_x11(Rect(0, 0, 1200, 1000))
        self.assertFalse(backend.ensure_chat_window_size(820, 525))
        backend.x11.XMoveResizeWindow.assert_not_called()
