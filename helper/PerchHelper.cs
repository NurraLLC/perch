// Perch helper: a Chrome native-messaging host. For each float it creates a frameless,
// always-on-top host window and places the Chrome popup window inside it as a child,
// offset so Chrome's own title and address bars fall outside the host and are cropped away.
// Chrome keeps rendering the page itself (protected video, subtitles, logins all intact).
// Built with the C# compiler that ships with Windows (.NET Framework 4.x, C# 5 syntax).
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

namespace Perch
{
    [StructLayout(LayoutKind.Sequential)] struct RECT { public int L, T, R, B; }
    [StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public POINT pt; }
    [StructLayout(LayoutKind.Sequential)] struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }
    [StructLayout(LayoutKind.Sequential)] struct MARGINS { public int L, R, T, B; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct WNDCLASSEX
    {
        public int cbSize; public uint style; public W.WndProc lpfnWndProc; public int cbClsExtra; public int cbWndExtra;
        public IntPtr hInstance; public IntPtr hIcon; public IntPtr hCursor; public IntPtr hbrBackground;
        public string lpszMenuName; public string lpszClassName; public IntPtr hIconSm;
    }

    static class W
    {
        public delegate bool EnumProc(IntPtr h, IntPtr l);
        public delegate IntPtr WndProc(IntPtr h, uint msg, IntPtr w, IntPtr l);
        [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder sb, int max);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder sb, int max);
        [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
        [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
        [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
        [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
        [DllImport("user32.dll")] public static extern IntPtr SetParent(IntPtr child, IntPtr parent);
        [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr h);
        [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr h, int i);
        [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")] public static extern IntPtr SetWindowLongPtr(IntPtr h, int i, IntPtr v);
        [DllImport("user32.dll")] public static extern bool SetLayeredWindowAttributes(IntPtr h, uint key, byte alpha, uint flags);
        [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
        [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vk);
        [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
        [DllImport("user32.dll")] public static extern IntPtr MonitorFromRect(ref RECT r, uint flags);
        [DllImport("user32.dll")] public static extern bool GetMonitorInfoW(IntPtr m, ref MONITORINFO mi);
        [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
        [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
        [DllImport("user32.dll")] public static extern bool RegisterHotKey(IntPtr h, int id, uint mods, uint vk);
        [DllImport("user32.dll")] public static extern bool PeekMessageW(out MSG m, IntPtr h, uint min, uint max, uint remove);
        [DllImport("user32.dll")] public static extern bool TranslateMessage(ref MSG m);
        [DllImport("user32.dll")] public static extern IntPtr DispatchMessageW(ref MSG m);
        [DllImport("user32.dll")] public static extern uint MsgWaitForMultipleObjects(uint n, IntPtr handles, bool all, uint ms, uint mask);
        [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
        [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
        [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern ushort RegisterClassExW(ref WNDCLASSEX wc);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr CreateWindowExW(uint ex, string cls, string title, uint style, int x, int y, int w, int h, IntPtr parent, IntPtr menu, IntPtr inst, IntPtr param);
        [DllImport("user32.dll")] public static extern bool DestroyWindow(IntPtr h);
        [DllImport("user32.dll")] public static extern IntPtr DefWindowProcW(IntPtr h, uint msg, IntPtr w, IntPtr l);
        [DllImport("user32.dll")] public static extern IntPtr LoadCursorW(IntPtr inst, IntPtr id);
        [DllImport("gdi32.dll")] public static extern IntPtr GetStockObject(int i);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr GetModuleHandleW(string name);
        [DllImport("dwmapi.dll")] public static extern int DwmSetWindowAttribute(IntPtr h, int attr, ref int value, int size);
        [DllImport("dwmapi.dll")] public static extern int DwmExtendFrameIntoClientArea(IntPtr h, ref MARGINS m);
        public delegate void WinEventProc(IntPtr hook, uint ev, IntPtr hwnd, int idObject, int idChild, uint thread, uint time);
        [DllImport("user32.dll")] public static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr mod, WinEventProc proc, uint pid, uint tid, uint flags);
    }

    // A float window the extension is about to create: hide it the moment it appears,
    // so the user never sees it with Chrome's frame before it's cropped.
    class Expected
    {
        public int Id; public string Token; public HashSet<IntPtr> Excluded = new HashSet<IntPtr>();
        public IntPtr Hwnd; public RECT Orig; public bool HasOrig; public long Deadline;
        public RECT Source; public bool HasSource; // the window the user floated from
    }

    class Float
    {
        public int Id; public IntPtr Chrome; public IntPtr Host; public string Token; public string Kind = "video";
        public long OrigStyle, OrigExStyle;
        public int Fx, Fy, Fr, Fb;            // Chrome window edge to page viewport, device px
        public bool Pinned = true, Ghost; public int Opacity = 100; public double Alpha = 255;
        public int Link;                       // parent float id for a docked chat float
        public long Touched, Deadline;
        public double Iw, Ih, Dpr;
        public Dictionary<string, object> Want;
    }

    static class Program
    {
        static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
        static readonly ConcurrentQueue<Dictionary<string, object>> Inbox = new ConcurrentQueue<Dictionary<string, object>>();
        static readonly Dictionary<int, Float> Floats = new Dictionary<int, Float>();
        static readonly List<Float> Pending = new List<Float>();
        static readonly object OutLock = new object();
        static readonly bool Debug = Environment.GetEnvironmentVariable("PERCH_DEBUG") == "1";
        static Stream Out;
        static volatile bool Done;
        static bool HiddenAll;
        static W.WndProc HostProc;   // kept alive for the lifetime of the class registration
        static W.WinEventProc EventProc; // kept alive while the hooks exist
        static readonly Dictionary<int, Expected> Expects = new Dictionary<int, Expected>();
        const string HostClass = "PerchFloatHost";

        static Float Active; static string Mode, Edge; static POINT Start; static RECT StartRect; static bool Moved;

        static readonly IntPtr TOPMOST = new IntPtr(-1), NOTOPMOST = new IntPtr(-2);
        const uint SWP_NOSIZE = 0x1, SWP_NOMOVE = 0x2, SWP_NOZORDER = 0x4, SWP_NOACTIVATE = 0x10, SWP_FRAMECHANGED = 0x20, SWP_SHOWWINDOW = 0x40;
        const int GWL_STYLE = -16, GWL_EXSTYLE = -20;
        const long WS_CHILD = 0x40000000L, WS_POPUP = 0x80000000L, WS_VISIBLE = 0x10000000L, WS_CLIPCHILDREN = 0x02000000L;
        const long FRAME_BITS = 0x80CF0000L; // WS_POPUP | WS_CAPTION | WS_SYSMENU | WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX
        const long WS_EX_TOPMOST = 0x8, WS_EX_TRANSPARENT = 0x20, WS_EX_TOOLWINDOW = 0x80, WS_EX_LAYERED = 0x80000;
        const uint MOD_ALT = 1, MOD_CONTROL = 2, MOD_NOREPEAT = 0x4000;
        const string Version = "0.2.1";

        [STAThread]
        static void Main(string[] args)
        {
            try { W.SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { }
            RegisterHostClass();
            // Be told the instant any window appears or changes title (out of context, our thread).
            EventProc = OnWinEvent;
            W.SetWinEventHook(0x8002, 0x8002, IntPtr.Zero, EventProc, 0, 0, 0x0002); // EVENT_OBJECT_SHOW
            W.SetWinEventHook(0x800C, 0x800C, IntPtr.Zero, EventProc, 0, 0, 0x0002); // EVENT_OBJECT_NAMECHANGE
            Out = Console.OpenStandardOutput();
            var reader = new Thread(ReadLoop); reader.IsBackground = true; reader.Start();

            bool g = W.RegisterHotKey(IntPtr.Zero, 1, MOD_CONTROL | MOD_ALT | MOD_NOREPEAT, 0x47);  // Ctrl+Alt+G  ghost
            bool p = W.RegisterHotKey(IntPtr.Zero, 2, MOD_CONTROL | MOD_ALT | MOD_NOREPEAT, 0x50);  // Ctrl+Alt+P  play/pause
            bool h = W.RegisterHotKey(IntPtr.Zero, 3, MOD_CONTROL | MOD_ALT | MOD_NOREPEAT, 0x48);  // Ctrl+Alt+H  hide/show
            Send(Obj("type", "ready", "version", Version, "hotkeys", g && p && h));

            long lastWatch = 0;
            while (!Done)
            {
                uint wait = (Active != null || AnyGhost() || Expects.Count > 0) ? 8u : 33u;
                W.MsgWaitForMultipleObjects(0, IntPtr.Zero, false, wait, 0x04FF);
                MSG m;
                while (W.PeekMessageW(out m, IntPtr.Zero, 0, 0, 1))
                {
                    if (m.message == 0x0312 && m.hwnd == IntPtr.Zero) { var id = m.wParam.ToInt32(); Safe(() => OnHotkey(id)); continue; }
                    W.TranslateMessage(ref m); W.DispatchMessageW(ref m);
                }
                Dictionary<string, object> msg;
                while (Inbox.TryDequeue(out msg)) { var cap = msg; Safe(() => Handle(cap)); }
                Safe(TryPending);
                Safe(TickInteraction);
                Safe(TickAlpha);
                long now = Environment.TickCount;
                if (now - lastWatch > 150) { lastWatch = now; Safe(Watchdog); }
            }
            // Chrome exits or the extension disconnects: give every window back untouched.
            foreach (var f in new List<Float>(Floats.Values)) Safe(() => Release(f));
        }

        // ---------- host window class
        static void RegisterHostClass()
        {
            HostProc = HostWndProc;
            var wc = new WNDCLASSEX
            {
                cbSize = Marshal.SizeOf(typeof(WNDCLASSEX)), lpfnWndProc = HostProc, hInstance = W.GetModuleHandleW(null),
                hCursor = W.LoadCursorW(IntPtr.Zero, new IntPtr(32512)), hbrBackground = W.GetStockObject(4), lpszClassName = HostClass
            };
            W.RegisterClassExW(ref wc);
        }

        static IntPtr HostWndProc(IntPtr h, uint msg, IntPtr w, IntPtr l)
        {
            if (msg == 0x0010) return IntPtr.Zero; // WM_CLOSE: the extension decides when a float closes
            return W.DefWindowProcW(h, msg, w, l);
        }

        static IntPtr CreateHost(RECT r)
        {
            uint ex = (uint)(WS_EX_TOPMOST | WS_EX_TOOLWINDOW);
            uint style = unchecked((uint)(WS_POPUP | WS_CLIPCHILDREN));
            IntPtr host = W.CreateWindowExW(ex, HostClass, "Perch", style, r.L, r.T, r.R - r.L, r.B - r.T, IntPtr.Zero, IntPtr.Zero, W.GetModuleHandleW(null), IntPtr.Zero);
            int round = 2; W.DwmSetWindowAttribute(host, 33, ref round, 4);       // Windows 11 rounded corners
            var margins = new MARGINS { L = 0, R = 0, T = 1, B = 0 }; W.DwmExtendFrameIntoClientArea(host, ref margins); // soft shadow
            return host;
        }

        // ---------- native messaging I/O
        static void ReadLoop()
        {
            try
            {
                var input = Console.OpenStandardInput();
                var len = new byte[4];
                while (ReadAll(input, len, 4))
                {
                    int n = BitConverter.ToInt32(len, 0);
                    if (n <= 0 || n > (1 << 20)) break;
                    var buf = new byte[n];
                    if (!ReadAll(input, buf, n)) break;
                    var obj = Json.DeserializeObject(Encoding.UTF8.GetString(buf)) as Dictionary<string, object>;
                    if (obj != null) Inbox.Enqueue(obj);
                }
            }
            catch { }
            Done = true;
        }

        static bool ReadAll(Stream s, byte[] buf, int n)
        {
            int off = 0;
            while (off < n) { int r = s.Read(buf, off, n - off); if (r <= 0) return false; off += r; }
            return true;
        }

        static void Send(Dictionary<string, object> o)
        {
            var bytes = Encoding.UTF8.GetBytes(Json.Serialize(o));
            lock (OutLock)
            {
                try { Out.Write(BitConverter.GetBytes(bytes.Length), 0, 4); Out.Write(bytes, 0, bytes.Length); Out.Flush(); }
                catch { Done = true; }
            }
        }

        static Dictionary<string, object> Obj(params object[] kv)
        {
            var d = new Dictionary<string, object>();
            for (int i = 0; i + 1 < kv.Length; i += 2) d[(string)kv[i]] = kv[i + 1];
            return d;
        }

        static object Rect(RECT r) { return Obj("x", r.L, "y", r.T, "w", r.R - r.L, "h", r.B - r.T); }

        static void Safe(Action a)
        {
            try { a(); }
            catch (Exception e)
            {
                try
                {
                    var dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Perch");
                    Directory.CreateDirectory(dir);
                    File.AppendAllText(Path.Combine(dir, "helper.log"), DateTime.Now.ToString("s") + " " + e + Environment.NewLine);
                }
                catch { }
            }
        }

        static double Num(Dictionary<string, object> d, string k, double fallback)
        {
            object v; if (d == null || !d.TryGetValue(k, out v) || v == null) return fallback;
            try { return Convert.ToDouble(v); } catch { return fallback; }
        }
        static bool Bool(Dictionary<string, object> d, string k) { object v; return d.TryGetValue(k, out v) && v is bool && (bool)v; }
        static string Str(Dictionary<string, object> d, string k) { object v; return d.TryGetValue(k, out v) && v != null ? v.ToString() : null; }
        static Dictionary<string, object> Sub(Dictionary<string, object> d, string k) { object v; return d != null && d.TryGetValue(k, out v) ? v as Dictionary<string, object> : null; }

        // ---------- commands from the extension
        static void Handle(Dictionary<string, object> msg)
        {
            string type = Str(msg, "type");
            int id = (int)Num(msg, "id", 0);
            Float f; Floats.TryGetValue(id, out f);
            switch (type)
            {
                case "ping": Send(Obj("type", "pong", "version", Version)); break;
                case "expect":
                {
                    // The float is always a brand-new window, so every Chrome window that exists right
                    // now (including the tab's current one, whose title may not show the token yet) is excluded.
                    var e = new Expected { Id = id, Token = Str(msg, "token"), Deadline = Environment.TickCount + 8000 };
                    W.EnumWindows((h, l) => { if (IsChrome(h)) e.Excluded.Add(h); return true; }, IntPtr.Zero);
                    // The user just clicked Float or pressed Alt+P, so the foreground window is
                    // the one they're looking at: the float belongs on that monitor.
                    IntPtr fg = W.GetForegroundWindow();
                    if (fg != IntPtr.Zero && W.GetWindowRect(fg, out e.Source)) e.HasSource = true;
                    DebugLog("expect " + id + " token=" + e.Token + " excluded=" + e.Excluded.Count);
                    Expects[id] = e;
                    Send(Obj("type", "expecting", "id", id));
                    break;
                }
                case "attach":
                    if (f != null) Release(f);
                    Pending.RemoveAll(x => x.Id == id);
                    Pending.Add(new Float
                    {
                        Id = id, Token = Str(msg, "token"), Kind = Str(msg, "kind") ?? "video",
                        Iw = Num(msg, "iw", 0), Ih = Num(msg, "ih", 0), Dpr = Num(msg, "dpr", 1),
                        Link = (int)Num(msg, "link", 0), Want = msg, Deadline = Environment.TickCount + 6000,
                        Ghost = Bool(msg, "ghost"), Opacity = (int)Num(msg, "opacity", 100), Pinned = !msg.ContainsKey("pinned") || Bool(msg, "pinned")
                    });
                    break;
                case "calib":
                    if (f == null || Active == f) break;
                    f.Iw = Num(msg, "iw", f.Iw); f.Ih = Num(msg, "ih", f.Ih); f.Dpr = Num(msg, "dpr", f.Dpr);
                    Recalibrate(f);
                    break;
                case "drag": if (f != null) Begin(f, "drag", null); break;
                case "resize": if (f != null) Begin(f, "resize", Str(msg, "edge") ?? "br"); break;
                case "fit": if (f != null) Fit(f, Num(msg, "aspect", 16.0 / 9.0)); break;
                case "ghost": if (f != null) { f.Ghost = Bool(msg, "on"); f.Touched = Environment.TickCount; ApplyStyle(f); SendState(f); } break;
                case "opacity": if (f != null) { f.Opacity = Math.Max(15, Math.Min(100, (int)Num(msg, "value", 100))); ApplyStyle(f); SendState(f); } break;
                case "pin": if (f != null) { f.Pinned = Bool(msg, "on"); ZOrder(f); SendState(f); } break;
                case "release":
                    if (f != null) Release(f);
                    Pending.RemoveAll(x => x.Id == id);
                    Expected ex;
                    if (Expects.TryGetValue(id, out ex)) { Unhide(ex); Expects.Remove(id); }
                    Send(Obj("type", "released", "id", id));
                    break;
            }
        }

        static void OnHotkey(int which)
        {
            Float last = null;
            foreach (var f in Floats.Values) if (f.Kind == "video" && (last == null || f.Touched > last.Touched)) last = f;
            if (last == null) foreach (var f in Floats.Values) if (last == null || f.Touched > last.Touched) last = f;
            if (which == 1 && last != null) { last.Ghost = !last.Ghost; ApplyStyle(last); SendState(last); }
            else if (which == 2 && last != null) Send(Obj("type", "hotkey", "name", "playpause", "id", last.Id));
            else if (which == 3)
            {
                HiddenAll = !HiddenAll;
                foreach (var f in Floats.Values) { W.ShowWindow(f.Host, HiddenAll ? 0 : 4); if (!HiddenAll) ZOrder(f); }
            }
        }

        // ---------- attaching to the Chrome window that carries our title token
        static void TryPending()
        {
            // Catch expected windows the hook may have missed.
            foreach (var e in new List<Expected>(Expects.Values))
            {
                if (Environment.TickCount > e.Deadline)
                {
                    // Never leave a video parked off-screen: if nobody claimed it, put it back.
                    DebugLog("expect expired " + e.Id + " hwnd=" + e.Hwnd);
                    Unhide(e);
                    Expects.Remove(e.Id);
                    continue;
                }
                if (e.Hwnd == IntPtr.Zero)
                {
                    IntPtr h = FindByToken(e.Token, e.Excluded);
                    if (h != IntPtr.Zero) Capture(e, h);
                }
            }
            for (int i = Pending.Count - 1; i >= 0; i--)
            {
                var f = Pending[i];
                Expected ex; Expects.TryGetValue(f.Id, out ex);
                IntPtr hwnd = ex != null && ex.Hwnd != IntPtr.Zero ? ex.Hwnd
                    : string.IsNullOrEmpty(f.Token) ? IntPtr.Zero : FindByToken(f.Token, ex != null ? ex.Excluded : null);
                if (hwnd != IntPtr.Zero) { DebugLog("attach " + f.Id + " hwnd=" + hwnd + " iw=" + f.Iw + " ih=" + f.Ih); Pending.RemoveAt(i); Attach(f, hwnd, ex); Expects.Remove(f.Id); }
                else if (Environment.TickCount > f.Deadline)
                {
                    DebugLog("attachFailed " + f.Id);
                    Pending.RemoveAt(i);
                    if (ex != null) { Unhide(ex); Expects.Remove(f.Id); }
                    Send(Obj("type", "attachFailed", "id", f.Id));
                }
            }
        }

        static void OnWinEvent(IntPtr hook, uint ev, IntPtr hwnd, int idObject, int idChild, uint thread, uint time)
        {
            if (Expects.Count == 0 || idObject != 0 || hwnd == IntPtr.Zero) return;
            Safe(() =>
            {
                if (!W.IsWindowVisible(hwnd) || !IsChrome(hwnd)) return;
                foreach (var e in Expects.Values)
                {
                    if (e.Hwnd != IntPtr.Zero || e.Excluded.Contains(hwnd) || !TitleHas(hwnd, e.Token)) continue;
                    Capture(e, hwnd);
                    break;
                }
            });
        }

        // Park the new window just off the left of the desktop until it's attached.
        static void DebugLog(string line)
        {
            if (!Debug) return;
            try
            {
                var dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Perch");
                File.AppendAllText(Path.Combine(dir, "debug.log"), DateTime.Now.ToString("HH:mm:ss.fff") + " " + line + Environment.NewLine);
            }
            catch { }
        }

        static void Capture(Expected e, IntPtr h)
        {
            DebugLog("capture " + e.Id + " hwnd=" + h + " zoomed=" + W.IsZoomed(h));
            e.Hwnd = h;
            if (W.IsZoomed(h)) W.ShowWindow(h, 4); // un-maximize without activating, or it can't be parked
            RECT r;
            if (W.GetWindowRect(h, out r)) { e.Orig = r; e.HasOrig = true; }
            int x = W.GetSystemMetrics(76) - (r.R - r.L) - 400, y = W.GetSystemMetrics(77);
            W.SetWindowPos(h, IntPtr.Zero, x, y, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
        }

        static void Unhide(Expected e)
        {
            if (e.Hwnd == IntPtr.Zero || !e.HasOrig || !W.IsWindow(e.Hwnd) || W.GetParent(e.Hwnd) != IntPtr.Zero) return;
            W.SetWindowPos(e.Hwnd, IntPtr.Zero, e.Orig.L, e.Orig.T, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
        }

        static bool IsChrome(IntPtr h)
        {
            var cls = new StringBuilder(64); W.GetClassNameW(h, cls, 64);
            return cls.ToString() == "Chrome_WidgetWin_1";
        }

        static bool TitleHas(IntPtr h, string token)
        {
            if (string.IsNullOrEmpty(token)) return false;
            var title = new StringBuilder(512); W.GetWindowTextW(h, title, 512);
            return title.ToString().IndexOf(token, StringComparison.Ordinal) >= 0;
        }

        static void ForEachChromeWindow(Action<IntPtr> each)
        {
            W.EnumWindows((h, l) => { if (W.IsWindowVisible(h) && IsChrome(h)) each(h); return true; }, IntPtr.Zero);
        }

        static IntPtr FindByToken(string token, HashSet<IntPtr> excluded)
        {
            IntPtr found = IntPtr.Zero;
            ForEachChromeWindow(h => { if (found == IntPtr.Zero && (excluded == null || !excluded.Contains(h)) && TitleHas(h, token)) found = h; });
            return found;
        }

        static void Attach(Float f, IntPtr chrome, Expected ex)
        {
            f.Chrome = chrome; f.Touched = Environment.TickCount;
            Calibrate(f);
            double s = ScaleOf(chrome);
            RECT target;
            Float parent;
            var want = Sub(f.Want, "rect");
            if (f.Link != 0 && Floats.TryGetValue(f.Link, out parent))
            {
                target = DockRect(parent, (int)(340 * s));
            }
            else if (want != null && OnSomeMonitor(want) && SameMonitor(want, Anchor(chrome, ex)))
            {
                target = new RECT { L = (int)Num(want, "x", 0), T = (int)Num(want, "y", 0) };
                target.R = target.L + Math.Max((int)(200 * s), (int)Num(want, "w", 480 * s));
                target.B = target.T + Math.Max((int)(112 * s), (int)Num(want, "h", 270 * s));
            }
            else
            {
                var def = Sub(f.Want, "def");
                int w = (int)(Num(def, "w", 480) * s), h = (int)(Num(def, "h", 270) * s), m = (int)(20 * s);
                // Bottom-right of the screen the user floated from (the parked window itself is off-screen).
                var wa = WorkArea(Anchor(chrome, ex));
                target = new RECT { L = wa.R - m - w, T = wa.B - m - h, R = wa.R - m, B = wa.B - m };
            }

            f.Host = CreateHost(target);
            f.OrigStyle = W.GetWindowLongPtr(chrome, GWL_STYLE).ToInt64();
            f.OrigExStyle = W.GetWindowLongPtr(chrome, GWL_EXSTYLE).ToInt64();
            W.SetWindowLongPtr(chrome, GWL_STYLE, new IntPtr((f.OrigStyle & ~FRAME_BITS) | WS_CHILD | WS_VISIBLE));
            W.SetWindowLongPtr(chrome, GWL_EXSTYLE, new IntPtr(f.OrigExStyle & ~(WS_EX_TOPMOST | WS_EX_LAYERED | WS_EX_TRANSPARENT)));
            W.SetParent(chrome, f.Host);
            Floats[f.Id] = f;
            Place(f, target.L, target.T, target.R - target.L, target.B - target.T, false);
            W.ShowWindow(f.Host, 5);
            ApplyStyle(f);
            Send(Obj("type", "attached", "id", f.Id, "rect", Rect(Viewport(f))));
            SendState(f);
            if (Debug) Send(Obj("type", "debug", "fx", f.Fx, "fy", f.Fy, "fr", f.Fr, "fb", f.Fb));
        }

        // Where the float should appear: the window the user floated from, else where Chrome
        // first created the float window, else wherever it is now.
        static RECT Anchor(IntPtr chrome, Expected ex)
        {
            if (ex != null && ex.HasSource) return ex.Source;
            if (ex != null && ex.HasOrig) return ex.Orig;
            RECT r; W.GetWindowRect(chrome, out r); return r;
        }

        static bool SameMonitor(Dictionary<string, object> want, RECT anchor)
        {
            var rc = new RECT { L = (int)Num(want, "x", 0), T = (int)Num(want, "y", 0) };
            rc.R = rc.L + (int)Num(want, "w", 0); rc.B = rc.T + (int)Num(want, "h", 0);
            return W.MonitorFromRect(ref rc, 2) == W.MonitorFromRect(ref anchor, 2);
        }

        static bool OnSomeMonitor(Dictionary<string, object> r)
        {
            var rc = new RECT { L = (int)Num(r, "x", 0), T = (int)Num(r, "y", 0) };
            rc.R = rc.L + (int)Num(r, "w", 0); rc.B = rc.T + (int)Num(r, "h", 0);
            return rc.R - rc.L > 0 && W.MonitorFromRect(ref rc, 0) != IntPtr.Zero;
        }

        // The page viewport sits at the bottom of the Chrome window, centred horizontally;
        // everything above it is Chrome's own title and address bar.
        static void Calibrate(Float f)
        {
            RECT wr; if (!W.GetWindowRect(f.Chrome, out wr)) return;
            int ww = wr.R - wr.L, wh = wr.B - wr.T;
            int iw = (int)Math.Round(f.Iw * f.Dpr), ih = (int)Math.Round(f.Ih * f.Dpr);
            if (iw <= 0 || ih <= 0 || iw > ww || ih > wh) { f.Fx = f.Fy = f.Fr = f.Fb = 0; return; }
            int side = (ww - iw) / 2;
            f.Fx = side; f.Fr = ww - iw - side; f.Fb = side; f.Fy = wh - ih - side;
            if (f.Fy < 0) { f.Fy = 0; f.Fb = wh - ih; }
        }

        // After a resize Chrome reports the real viewport; if our offsets were off, fix them.
        static void Recalibrate(Float f)
        {
            if (f.Host == IntPtr.Zero) return;
            var v = Viewport(f);
            int iw = (int)Math.Round(f.Iw * f.Dpr), ih = (int)Math.Round(f.Ih * f.Dpr);
            int w = v.R - v.L, h = v.B - v.T;
            if (Math.Abs(iw - w) <= 1 && Math.Abs(ih - h) <= 1) return;
            RECT cr; W.GetWindowRect(f.Chrome, out cr);
            int cw = cr.R - cr.L, ch = cr.B - cr.T;
            if (iw <= 0 || ih <= 0 || iw > cw || ih > ch) return;
            int side = (cw - iw) / 2;
            f.Fx = side; f.Fr = cw - iw - side; f.Fb = side; f.Fy = Math.Max(0, ch - ih - side);
            PlaceChild(f, w, h);
        }

        static RECT Viewport(Float f) { RECT r; W.GetWindowRect(f.Host, out r); return r; }

        static double ScaleOf(IntPtr hwnd)
        {
            uint dpi = 96; try { dpi = W.GetDpiForWindow(hwnd); } catch { }
            return (dpi == 0 ? 96 : dpi) / 96.0;
        }
        static double Scale(Float f) { return ScaleOf(f.Host != IntPtr.Zero ? f.Host : f.Chrome); }

        static RECT WorkArea(RECT r)
        {
            var mon = W.MonitorFromRect(ref r, 2);
            var mi = new MONITORINFO(); mi.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
            W.GetMonitorInfoW(mon, ref mi);
            return mi.rcWork;
        }

        static void PlaceChild(Float f, int w, int h)
        {
            W.SetWindowPos(f.Chrome, IntPtr.Zero, -f.Fx, -f.Fy, w + f.Fx + f.Fr, h + f.Fy + f.Fb, SWP_NOZORDER | SWP_NOACTIVATE);
        }

        static void Place(Float f, int x, int y, int w, int h, bool moveOnly)
        {
            // Size Chrome's window first: it starts redrawing at the new size before the host
            // grows, so the host's empty background isn't exposed at the growing edge.
            if (!moveOnly) PlaceChild(f, w, h);
            W.SetWindowPos(f.Host, f.Pinned ? TOPMOST : NOTOPMOST, x, y, w, h, SWP_NOACTIVATE | (moveOnly ? SWP_NOSIZE : 0));
            DockChildren(f);
        }

        static void ZOrder(Float f) { W.SetWindowPos(f.Host, f.Pinned ? TOPMOST : NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE); }

        static void ApplyStyle(Float f)
        {
            long ex = W.GetWindowLongPtr(f.Host, GWL_EXSTYLE).ToInt64();
            bool layered = f.Ghost || f.Opacity < 100;
            long next = layered ? (ex | WS_EX_LAYERED) : (ex & ~WS_EX_LAYERED);
            next = f.Ghost ? (next | WS_EX_TRANSPARENT) : (next & ~WS_EX_TRANSPARENT);
            if (next != ex) W.SetWindowLongPtr(f.Host, GWL_EXSTYLE, new IntPtr(next));
            if (layered) { f.Alpha = BaseAlpha(f); W.SetLayeredWindowAttributes(f.Host, 0, (byte)Math.Round(f.Alpha), 2); }
            ZOrder(f);
        }

        static double BaseAlpha(Float f) { return (f.Ghost && f.Opacity >= 100 ? 70 : f.Opacity) * 2.55; }

        static bool AnyGhost() { foreach (var f in Floats.Values) if (f.Ghost) return true; return false; }

        // Ghost floats fade almost away while the cursor is over them, so you see what you click.
        static void TickAlpha()
        {
            POINT p; W.GetCursorPos(out p);
            foreach (var f in Floats.Values)
            {
                if (!f.Ghost) continue;
                var v = Viewport(f);
                bool inside = p.X >= v.L && p.X < v.R && p.Y >= v.T && p.Y < v.B;
                double target = inside ? 0.18 * 255 : BaseAlpha(f);
                if (Math.Abs(f.Alpha - target) < 0.6) continue;
                f.Alpha += (target - f.Alpha) * 0.28;
                if (Math.Abs(f.Alpha - target) < 1) f.Alpha = target;
                W.SetLayeredWindowAttributes(f.Host, 0, (byte)Math.Max(1, Math.Round(f.Alpha)), 2);
            }
        }

        // ---------- drag / resize, driven by the physical mouse button
        static bool ButtonDown() { int vk = W.GetSystemMetrics(23) != 0 ? 0x02 : 0x01; return (W.GetAsyncKeyState(vk) & 0x8000) != 0; }

        static void Begin(Float f, string mode, string edge)
        {
            Active = f; Mode = mode; Edge = edge; Moved = false; f.Touched = Environment.TickCount;
            W.GetCursorPos(out Start); StartRect = Viewport(f);
        }

        static void TickInteraction()
        {
            if (Active == null) return;
            var f = Active;
            if (!W.IsWindow(f.Host)) { Active = null; return; }
            if (!ButtonDown()) { End(); return; }
            POINT p; W.GetCursorPos(out p);
            int dx = p.X - Start.X, dy = p.Y - Start.Y;
            if (!Moved && Math.Abs(dx) < 3 && Math.Abs(dy) < 3) return;
            Moved = true;
            var s = StartRect;
            if (Mode == "drag") { Place(f, s.L + dx, s.T + dy, s.R - s.L, s.B - s.T, true); return; }

            double sc = Scale(f);
            int l = s.L, t = s.T, r = s.R, b = s.B;
            bool L = Edge.IndexOf('l') >= 0, R = Edge.IndexOf('r') >= 0, T = Edge.IndexOf('t') >= 0, B = Edge.IndexOf('b') >= 0;
            if (L) l += dx; if (R) r += dx; if (T) t += dy; if (B) b += dy;
            int minW = (int)(200 * sc), minH = (int)(112 * sc);
            if (r - l < minW) { if (L) l = r - minW; else r = l + minW; }
            if (b - t < minH) { if (T) t = b - minH; else b = t + minH; }
            if ((W.GetAsyncKeyState(0x10) & 0x8000) != 0)
            {
                double aspect = (s.R - s.L) / (double)Math.Max(1, s.B - s.T);
                if ((L || R) && !(T || B)) b = t + (int)((r - l) / aspect);
                else if ((T || B) && !(L || R)) r = l + (int)((b - t) * aspect);
                else { int hh = (int)((r - l) / aspect); if (T) t = b - hh; else b = t + hh; }
            }
            Place(f, l, t, r - l, b - t, false);
        }

        static void End()
        {
            var f = Active; Active = null;
            if (f == null || !Moved) return;
            if (Mode == "drag") Snap(f);
            ReportPlaced(f);
        }

        static void Snap(Float f)
        {
            var v = Viewport(f); var wa = WorkArea(v); double s = Scale(f);
            int thr = (int)(28 * s), m = (int)(12 * s), w = v.R - v.L, h = v.B - v.T, x = v.L, y = v.T;
            if (Math.Abs(v.L - wa.L) < thr) x = wa.L + m; else if (Math.Abs(wa.R - v.R) < thr) x = wa.R - m - w;
            if (Math.Abs(v.T - wa.T) < thr) y = wa.T + m; else if (Math.Abs(wa.B - v.B) < thr) y = wa.B - m - h;
            int keep = (int)(80 * s);
            x = Math.Max(wa.L - w + keep, Math.Min(wa.R - keep, x));
            y = Math.Max(wa.T, Math.Min(wa.B - keep, y));
            if (x != v.L || y != v.T) Place(f, x, y, w, h, true);
        }

        static void Fit(Float f, double aspect)
        {
            if (aspect <= 0.1 || aspect > 10) return;
            var v = Viewport(f); var wa = WorkArea(v);
            int w = v.R - v.L, h = (int)Math.Round(w / aspect);
            if (h > wa.B - wa.T) { h = wa.B - wa.T; w = (int)Math.Round(h * aspect); }
            int y = Math.Min(v.T, wa.B - h);
            Place(f, v.L, Math.Max(wa.T, y), w, h, false);
            ReportPlaced(f);
        }

        static RECT DockRect(Float parent, int width)
        {
            var pv = Viewport(parent); var wa = WorkArea(pv); int gap = (int)(8 * Scale(parent));
            int x = pv.R + gap; if (x + width > wa.R) x = pv.L - gap - width;
            return new RECT { L = x, T = pv.T, R = x + width, B = pv.B };
        }

        static void DockChildren(Float p)
        {
            foreach (var c in Floats.Values)
            {
                if (c.Link != p.Id || c.Host == IntPtr.Zero) continue;
                var cv = Viewport(c);
                var r = DockRect(p, cv.R - cv.L);
                bool sameSize = (r.B - r.T) == (cv.B - cv.T);
                if (!sameSize) PlaceChild(c, r.R - r.L, r.B - r.T);
                W.SetWindowPos(c.Host, c.Pinned ? TOPMOST : NOTOPMOST, r.L, r.T, r.R - r.L, r.B - r.T, SWP_NOACTIVATE | (sameSize ? SWP_NOSIZE : 0));
            }
        }

        static void ReportPlaced(Float f) { Send(Obj("type", "placed", "id", f.Id, "kind", f.Kind, "rect", Rect(Viewport(f)))); }

        static void SendState(Float f) { Send(Obj("type", "state", "id", f.Id, "ghost", f.Ghost, "opacity", f.Opacity, "pinned", f.Pinned)); }

        static void Watchdog()
        {
            foreach (var f in new List<Float>(Floats.Values))
            {
                if (!W.IsWindow(f.Chrome) || W.GetParent(f.Chrome) != f.Host)
                {
                    // Chrome closed or took the window back (the tab left it): drop the host.
                    Floats.Remove(f.Id); if (Active == f) Active = null;
                    if (W.IsWindow(f.Host)) W.DestroyWindow(f.Host);
                    Send(Obj("type", "gone", "id", f.Id));
                    continue;
                }
                if (f.Pinned && !HiddenAll && (W.GetWindowLongPtr(f.Host, GWL_EXSTYLE).ToInt64() & WS_EX_TOPMOST) == 0) ZOrder(f);
            }
        }

        // Put the Chrome window back as an ordinary top-level window where the float was.
        static void Release(Float f)
        {
            Floats.Remove(f.Id);
            if (Active == f) Active = null;
            foreach (var c in Floats.Values) if (c.Link == f.Id) c.Link = 0;
            if (f.Host == IntPtr.Zero) return;
            RECT v = Viewport(f);
            if (W.IsWindow(f.Chrome))
            {
                W.ShowWindow(f.Chrome, 0);
                W.SetParent(f.Chrome, IntPtr.Zero);
                W.SetWindowLongPtr(f.Chrome, GWL_STYLE, new IntPtr(f.OrigStyle));
                W.SetWindowLongPtr(f.Chrome, GWL_EXSTYLE, new IntPtr(f.OrigExStyle & ~WS_EX_TOPMOST));
                W.SetWindowPos(f.Chrome, NOTOPMOST, v.L - f.Fx, v.T - f.Fy, (v.R - v.L) + f.Fx + f.Fr, (v.B - v.T) + f.Fy + f.Fb, SWP_FRAMECHANGED | SWP_NOACTIVATE | SWP_SHOWWINDOW);
            }
            if (W.IsWindow(f.Host)) W.DestroyWindow(f.Host);
            f.Host = IntPtr.Zero;
        }
    }
}
