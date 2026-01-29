/** @type {import('tailwindcss').Config} */
module.exports = {
    content: ["./views/**/*.ejs"],
    theme: {
        fontFamily: {
            sans: ['Poppins', 'sans-serif'],
        },
        extend: {
            colors: {
                frutotos: {
                    green: '#4CAF50',
                    dark: '#2E7D32',
                    light: '#E8F5E9'
                }
            }
        },
    },
    plugins: [],
}
