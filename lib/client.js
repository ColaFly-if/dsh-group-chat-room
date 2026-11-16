window.__ModuleLoader__.load({
  id: "dsh-group-chat-room",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    // 这整个 factory 外面再包一层：任何异常都只让本插件退化成"没有按钮"，
    // 绝不把 web boot 拖垮（上次就是这种情况：inject 声明让 entry 永远 pending）。
    try {
      let react = require("react");
      const h = react.createElement;

      function icon(size) {
        const s = typeof size === "number" ? size : 18;
        return h(
          "svg",
          {
            width: s, height: s, viewBox: "0 0 24 24", fill: "none",
            stroke: "currentColor", strokeWidth: 1.8,
            strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true",
          },
          h("path", { d: "M20.5 11.6c0 4.2-3.8 7.6-8.5 7.6-1 0-2-.15-2.9-.42L4 20.4l1.3-3.6C4.1 15.4 3.5 13.6 3.5 11.6 3.5 7.4 7.3 4 12 4s8.5 3.4 8.5 7.6Z" }),
          h("circle", { cx: 9, cy: 11.6, r: 1.05, fill: "currentColor", stroke: "none" }),
          h("circle", { cx: 15, cy: 11.6, r: 1.05, fill: "currentColor", stroke: "none" })
        );
      }

      function GroupChatFrame() {
        return h("iframe", {
          src: "/groupchat/",
          title: "聊天群组",
          style: { width: "100%", height: "100%", minHeight: "360px", border: "0", display: "block", background: "#14161b" },
        });
      }

      // 不声明 inject：声明了会等 betterSidebar 就绪，boot 收尾检查把 pending 判成失败，
      // 整个窗口就打不开了（2026-11-13 的三次 crash 就是这个）。
      exports.inject = [];

      exports.apply = function (ctx) {
        try {
          var registered = false;
          var timer = null;

          function getService() {
            var svc = null;
            try { if (ctx && ctx.get) svc = ctx.get("betterSidebar"); } catch (e) { svc = null; }
            if (!svc && ctx) { try { svc = ctx.betterSidebar; } catch (e) { svc = null; } }
            return svc;
          }

          function tryRegister() {
            if (registered) return true;
            var svc = getService();
            if (!svc || typeof svc.registerTab !== "function") return false;
            try {
              var off = svc.registerTab({
                id: "groupchat",
                title: "聊天群组",
                description: "多人群聊，人格从工作区里扫出来，勾谁谁进群",
                icon: icon,
                order: 90,
                single: true,
                component: GroupChatFrame,
              });
              registered = true;
              if (ctx && ctx.effect && typeof off === "function") {
                try { ctx.effect(function () { return off; }, "dsh-group-chat-room:sidebar-tab"); } catch (e) {}
              }
              return true;
            } catch (e) {
              console.error("[dsh-group-chat-room] registerTab failed:", e);
              return false;
            }
          }

          if (tryRegister()) return;

          var tries = 0;
          timer = setInterval(function () {
            tries++;
            if (tryRegister() || tries > 240) {
              if (tries > 240) console.warn("[dsh-group-chat-room] betterSidebar 未出现，按钮不注册（不影响启动）");
              clearInterval(timer);
              timer = null;
            }
          }, 500);

          if (ctx && ctx.effect) {
            try {
              ctx.effect(function () {
                return function () { if (timer) clearInterval(timer); };
              }, "dsh-group-chat-room:retry");
            } catch (e) {}
          }
        } catch (e) {
          console.error("[dsh-group-chat-room] apply failed (已被吞掉，不影响启动):", e);
        }
      };
    } catch (err) {
      console.error("[dsh-group-chat-room] factory failed (已被吞掉，不影响启动):", err);
      exports.inject = [];
      exports.apply = function () {};
    }

    return module.exports;
  },
});
