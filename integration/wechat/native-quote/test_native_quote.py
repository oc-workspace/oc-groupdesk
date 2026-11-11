"""Synthetic UI tests for the native Quote sender; no live WeChat messages."""
from contextlib import contextmanager
from datetime import datetime,timezone
from types import SimpleNamespace as N
import unittest
from unittest.mock import patch

import bowxt.client as client_module
from bowxt.client import WeChatClient
from bowxt.errors import ControlNotFound
from bowxt.models import ChatType,Direction,Message,MessageType,Rect

TARGET='Unique synthetic summary first part'

class Node:
    def __init__(self,name='',role='panel',bounds=Rect(0,0,600,600),children=(),text=None):
        self.name=name;self.role=role;self.bounds=bounds;self._children=list(children)
        self.accessible_text=text;self.description='';self.attributes={};self.states=set()
        self.identity=str(id(self))
    def children(self):return self._children
    def relations(self):return {}

class Input:
    def __init__(self,ui):self.ui=ui;self.actions=[];self.right_point=None
    def scroll_up(self,*a,**k):self.actions.append('scroll')
    def right_click(self,*a):self.actions.append('right');self.right_point=a;self.ui.menu_visible=True
    def click_active_wechat(self,*a):
        self.actions.append('click')
        if self.ui.menu_visible:
            self.ui.menu_visible=False
            self.ui.quote=Node('Quote your message: '+self.ui.preview,'invalid',Rect(100,520,300,25))
            self.ui.delete=Node('Delete quote','push button',Rect(410,520,16,16))
            self.ui.root._children.extend([self.ui.quote,self.ui.delete])
        elif self.ui.delete and a==(418,528):
            self.ui.root._children.remove(self.ui.quote)
            self.ui.root._children.remove(self.ui.delete)
            self.ui.quote=self.ui.delete=None
    def shortcut_active_wechat(self,*keys):
        self.actions.append('+'.join(keys))
        if keys==('enter',) and self.ui.quote:
            self.ui.root._children.remove(self.ui.quote)
            self.ui.root._children.remove(self.ui.delete)
            self.ui.quote=self.ui.delete=None

class UI:
    def __init__(self):
        self.menu_visible=False;self.preview=TARGET;self.quote=self.delete=None
        self.editor=Node('editor','text',Rect(0,500,600,100),text='')
        self.message_list=Node('messages','list',Rect(0,0,600,480))
        self.menu=Node('引用','menu item',Rect(100,100,50,20))
        self.root=Node('WeChat','frame',children=[self.message_list,self.editor])
    def windows(self):return [Node('popup','window',children=[self.menu]) if self.menu_visible else self.root]

class Clipboard:
    @contextmanager
    def text(self,value):yield

class QuoteTests(unittest.TestCase):
    def setUp(self):
        self.addCleanup(patch.stopall)
        self.ui=UI();self.input=Input(self.ui)
        self.client=WeChatClient(accessibility=self.ui,input_backend=self.input,clipboard=Clipboard(),sleeper=lambda _:None)
        self.client.open_chat=lambda *a,**k:None
        self.client._ensure_root=lambda:self.ui.root
        self.client._verified_controls=lambda *a:(self.ui.message_list,self.ui.editor)
        self.client._assert_clean_surface=lambda *a,**k:None
        self.client._is_chat_open=lambda *a:True
        self.client._limiter=N(validate_text=lambda *a:None,acquire=lambda *a:None)
        self.client.get_visible_messages=lambda **k:[Message('synthetic','group',TARGET,MessageType.TEXT,Direction.OUTGOING,bounds=Rect(50,50,400,40))]
        patch.object(client_module,'find_editor',return_value=self.ui.editor).start()
        tree='0x1 "Weixin": ("wechat" "wechat") 600x600+0+0'
        popup='0x2 "wechat": ("wechat" "wechat") 162x360+360+70'
        calls=iter([tree,tree+'\n'+popup]*10)
        patch.object(client_module.subprocess,'check_output',side_effect=lambda *a,**k:next(calls)).start()
        patch.object(client_module.subprocess,'run',return_value=N(stderr='0 (0) @ 10,283',returncode=0)).start()
    def test_exact_target_and_preview_are_required_before_enter(self):
        receipt=self.client.send_native_quote('group',TARGET,'See earlier summary',chat_type=ChatType.GROUP)
        self.assertFalse(receipt.verified)
        self.assertIn('enter',self.input.actions)
        self.ui.preview='Different message'
        self.input.actions.clear()
        with self.assertRaises(ControlNotFound):self.client.send_native_quote('group',TARGET,'See earlier summary',chat_type=ChatType.GROUP)
        self.assertNotIn('enter',self.input.actions)
    def test_missing_or_ambiguous_target_cannot_send(self):
        self.client.get_visible_messages=lambda **k:[]
        with self.assertRaises(ControlNotFound):self.client.send_native_quote('group',TARGET,'See earlier summary')
        self.assertNotIn('enter',self.input.actions)
    def test_reader_proven_own_message_uses_right_bubble_even_when_ui_mislabels_direction(self):
        self.client.get_visible_messages=lambda **k:[Message('synthetic','group',TARGET,MessageType.TEXT,Direction.INCOMING,bounds=Rect(50,50,400,40))]
        receipt=self.client.send_native_quote('group',TARGET,'See earlier summary',target_is_own=True)
        self.assertFalse(receipt.verified)
        self.assertEqual(self.input.right_point,(360,70))
    def test_probe_closes_preview_without_sending(self):
        self.assertTrue(self.client.send_native_quote('group',TARGET,'probe',probe_only=True))
        self.assertIsNone(self.ui.quote)
        self.assertNotIn('enter',self.input.actions)
        self.input.actions.clear()
        duplicate=Message('synthetic','group',TARGET,MessageType.TEXT,Direction.OUTGOING,bounds=Rect(50,50,400,40))
        self.client.get_visible_messages=lambda **k:[duplicate,duplicate]
        with self.assertRaises(ControlNotFound):self.client.send_native_quote('group',TARGET,'See earlier summary')
        self.assertNotIn('enter',self.input.actions)

if __name__=='__main__':unittest.main()
