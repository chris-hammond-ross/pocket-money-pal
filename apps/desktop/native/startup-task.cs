// Reads or changes the Microsoft Store build's startup task (ADR 0027; src/startup-task.ts runs it).
//
//   startup-task.exe [read|enable|disable] [task id]   -> prints e.g. "Enabled 2"
//
// The first word is WinRT's StartupTaskState. The second is the State value Windows keeps for the
// task in the registry (what Task Manager and Settings show and change), or "none". The app trusts
// WinRT, and falls back on the registry when WinRT says DisabledByPolicy: a sideloaded test build
// gets that answer even while Task Manager shows the task enabled.
//
// WinRT's StartupTask needs the caller to have the app's package identity. Electron can't call
// WinRT, and a system program it starts (PowerShell) runs without the identity, but an exe inside
// the package does. So this ships in resources/, built by scripts/build.mjs with the C# compiler
// that comes with Windows' .NET Framework 4: no SDK or extra toolchain.
using System;
using System.Threading;
using Microsoft.Win32;
using Windows.ApplicationModel;
using Windows.Foundation;

static class Program
{
    static T Wait<T>(IAsyncOperation<T> operation)
    {
        while (operation.Status == AsyncStatus.Started) Thread.Sleep(20);
        return operation.GetResults();
    }

    static string RegistryState(string taskId)
    {
        try
        {
            string key = @"Software\Classes\Local Settings\Software\Microsoft\Windows\CurrentVersion\AppModel\SystemAppData\"
                + Package.Current.Id.FamilyName + @"\" + taskId;
            using (RegistryKey task = Registry.CurrentUser.OpenSubKey(key))
            {
                object state = task == null ? null : task.GetValue("State");
                return state == null ? "none" : state.ToString();
            }
        }
        catch
        {
            return "none";
        }
    }

    static int Main(string[] args)
    {
        string action = args.Length > 0 ? args[0] : "read";
        string taskId = args.Length > 1 ? args[1] : "PocketMoneyPalStartup";
        try
        {
            StartupTask task = Wait(StartupTask.GetAsync(taskId));
            if (action == "enable") Wait(task.RequestEnableAsync());
            else if (action == "disable") task.Disable();
            Console.WriteLine(task.State + " " + RegistryState(taskId));
            return 0;
        }
        catch (Exception e)
        {
            string package;
            try { package = Package.Current.Id.FamilyName; }
            catch { package = "no package identity"; }
            Console.Error.WriteLine(e.Message.Trim() + " (" + package + ")");
            return 1;
        }
    }
}
