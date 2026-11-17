import { Lock } from "lucide-react";
import { AnimatePresence, motion, useAnimationControls } from "motion/react";
import { useEffect, useState } from "react";
import { useApp } from "@/store/app";

export function LockScreen() {
  const locked = useApp((s) => s.locked);
  const unlock = useApp((s) => s.unlock);
  const [pw, setPw] = useState("");
  const shake = useAnimationControls();

  useEffect(() => setPw(""), [locked]);

  return (
    <AnimatePresence>
      {locked && (
        <motion.div
          initial={{ opacity: 0, backdropFilter: "blur(0px)" }}
          animate={{ opacity: 1, backdropFilter: "blur(18px)" }}
          exit={{ opacity: 0, backdropFilter: "blur(0px)" }}
          transition={{ duration: 0.25 }}
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/55"
          data-tauri-drag-region
        >
          <motion.form
            animate={shake}
            initial={{ y: 12, scale: 0.97 }}
            whileInView={{ y: 0, scale: 1 }}
            onSubmit={async (e) => {
              e.preventDefault();
              if (!(await unlock(pw))) {
                setPw("");
                void shake.start({ x: [0, -10, 10, -6, 6, 0], transition: { duration: 0.35 } });
              }
            }}
            className="flex w-72 flex-col items-center gap-4"
          >
            <div className="flex size-14 items-center justify-center rounded-2xl bg-ov/[0.07] text-foreground shadow-inner">
              <Lock className="size-6" />
            </div>
            <div className="text-[15px] font-medium">rainterm is locked</div>
            <input
              autoFocus
              type="password"
              value={pw}
              onChange={(e) => setPw(e.target.value)}
              placeholder="Password"
              className="h-9 w-full rounded-lg border border-ov/10 bg-inset px-3 text-center text-[13px] outline-none transition focus:border-primary/60"
            />
          </motion.form>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
