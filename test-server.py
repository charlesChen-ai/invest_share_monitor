#!/usr/bin/env python3
"""
简单的HTTP服务器用于测试投资账本页面
"""
import http.server
import socketserver
import os

PORT = 8888

class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # 添加CORS头，方便测试
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()
    
    def log_message(self, format, *args):
        # 简化日志输出
        print(f"{self.address_string()} - {format % args}")

if __name__ == '__main__':
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    
    with socketserver.TCPServer(("", PORT), Handler) as httpd:
        print(f"测试服务器启动在 http://localhost:{PORT}")
        print("可测试的页面:")
        print(f"  1. 操作页面: http://localhost:{PORT}/operation.html")
        print(f"  2. 快速测试: http://localhost:{PORT}/quick-test.html")
        print(f"  3. 详细测试: http://localhost:{PORT}/test-optimizer.html")
        print("\n按 Ctrl+C 停止服务器")
        
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n服务器已停止")