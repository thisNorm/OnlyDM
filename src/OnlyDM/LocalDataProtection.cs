using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

namespace OnlyDM;

internal static class LocalDataProtection
{
    private const string Prefix = "dpapi:";

    [StructLayout(LayoutKind.Sequential)]
    private struct DataBlob
    {
        public int Size;
        public IntPtr Data;
    }

    [DllImport("crypt32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CryptProtectData(
        ref DataBlob dataIn,
        string? description,
        IntPtr optionalEntropy,
        IntPtr reserved,
        IntPtr prompt,
        uint flags,
        out DataBlob dataOut);

    [DllImport("crypt32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CryptUnprotectData(
        ref DataBlob dataIn,
        IntPtr description,
        IntPtr optionalEntropy,
        IntPtr reserved,
        IntPtr prompt,
        uint flags,
        out DataBlob dataOut);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr LocalFree(IntPtr memory);

    public static bool IsProtected(string value) =>
        value.StartsWith(Prefix, StringComparison.Ordinal);

    public static string Protect(string value) =>
        Prefix + Convert.ToBase64String(Transform(Encoding.UTF8.GetBytes(value), protect: true));

    public static string Unprotect(string value)
    {
        if (!IsProtected(value)) return value;
        var bytes = Convert.FromBase64String(value[Prefix.Length..]);
        return Encoding.UTF8.GetString(Transform(bytes, protect: false));
    }

    private static byte[] Transform(byte[] input, bool protect)
    {
        var inputMemory = Marshal.AllocHGlobal(input.Length);
        var inputBlob = new DataBlob { Size = input.Length, Data = inputMemory };
        Marshal.Copy(input, 0, inputMemory, input.Length);

        try
        {
            DataBlob outputBlob;
            var success = protect
                ? CryptProtectData(ref inputBlob, null, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, 0, out outputBlob)
                : CryptUnprotectData(ref inputBlob, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, 0, out outputBlob);
            if (!success)
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }

            try
            {
                var output = new byte[outputBlob.Size];
                Marshal.Copy(outputBlob.Data, output, 0, output.Length);
                return output;
            }
            finally
            {
                LocalFree(outputBlob.Data);
            }
        }
       finally
       {
            for (var index = 0; index < input.Length; index++) Marshal.WriteByte(inputMemory, index, 0);
            Array.Clear(input, 0, input.Length);
            Marshal.FreeHGlobal(inputMemory);
       }
    }
}
